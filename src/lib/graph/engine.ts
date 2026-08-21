import type { Quadtree } from "d3-quadtree";
import { type BuiltGraph, type GraphTheme, type LayoutCache } from "./types";
import { copyPositions, createSimulation, tickBudget, type SimulationHandle } from "./simulate";
import {
  boundsOf,
  buildQuadtree,
  cameraFit,
  drawGraph,
  hitTest,
  readTheme,
} from "./renderer";

const K_MIN = 0.05;
const K_MAX = 4;
const HOVER_MS = 100;

export interface EngineCallbacks {
  onNodeClick: (id: string, kind: number) => void;
  onLayoutSettled: (cache: LayoutCache) => void;
  onCameraChange: (cam: { tx: number; ty: number; k: number }) => void;
  onLayoutHot: (hot: boolean) => void;
}

export class GraphEngine {
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private graph: BuiltGraph | null = null;
  private theme: GraphTheme;
  private tree: Quadtree<number> | null = null;
  private cb: EngineCallbacks;

  private tx = 0;
  private ty = 0;
  private k = 1;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  private hoverIndex = -1;
  private hoverT = 0;
  private hoverTarget = 0;
  private labelT = 0;
  private labelTarget = 0;
  private hoverClock = 0;
  private activeId: string | null = null;

  private raf = 0;
  private simHot = false;
  private interacting = false;
  private animating = false;
  private layingOut = false;

  private worker: Worker | null = null;
  private mainSim: SimulationHandle | null = null;
  private mainSimRaf = 0;
  private useWorker = true;

  private pointer = {
    down: false,
    button: -1,
    lastX: 0,
    lastY: 0,
    moved: false,
    downIndex: -1,
    pan: false,
  };
  private lastGestureScale = 1;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver | null = null;
  private pendingFit = false;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement, cb: EngineCallbacks) {
    this.canvas = canvas;
    this.wrap = wrap;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
    this.cb = cb;
    this.theme = readTheme(wrap);
    this.bind();
    this.resize();
  }

  setThemeFrom(el: HTMLElement) {
    this.theme = readTheme(el);
    this.requestDraw();
  }

  setActiveId(id: string | null) {
    this.activeId = id;
    this.requestDraw();
  }

  getCamera() {
    return { tx: this.tx, ty: this.ty, k: this.k };
  }

  setCamera(cam: { tx: number; ty: number; k: number }, emit = false) {
    this.tx = cam.tx;
    this.ty = cam.ty;
    this.k = Math.max(K_MIN, Math.min(K_MAX, cam.k));
    this.updateLabelTarget();
    this.requestDraw();
    if (emit) this.emitCamera();
  }

  setGraph(graph: BuiltGraph) {
    this.stopSim();
    this.graph = graph;
    this.tree = buildQuadtree(graph);
    this.updateLabelTarget();
    this.requestDraw();
  }

  zoomToFit() {
    if (this.cssW < 2 || this.cssH < 2) {
      this.pendingFit = true;
      return;
    }
    if (!this.graph) return;
    const b = boundsOf(this.graph);
    if (!b) return;
    const cam = cameraFit(b, this.cssW, this.cssH);
    this.setCamera(cam, true);
  }

  startLayout(alpha: number, showShimmer: boolean) {
    if (!this.graph || this.graph.nodeCount === 0) return;
    this.layingOut = showShimmer;
    this.cb.onLayoutHot(showShimmer);
    this.simHot = true;
    this.requestDraw();

    if (this.useWorker) {
      try {
        this.startWorker(alpha);
        return;
      } catch {
        this.useWorker = false;
      }
    }
    this.startMainThread(alpha);
  }

  destroy() {
    this.destroyed = true;
    this.stopSim();
    this.unbind();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.ro?.disconnect();
  }

  // ─── Simulation ───

  private startWorker(alpha: number) {
    const g = this.graph!;
    this.killWorker();
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<{ type: string; positions: Float32Array }>) => {
      if (this.destroyed || this.worker !== worker) return;
      g.positions = e.data.positions;
      this.tree = buildQuadtree(g);
      if (e.data.type === "done") this.onSimDone();
      else this.requestDraw();
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.useWorker = false;
      this.killWorker();
      this.startMainThread(alpha);
    };
    const pos = g.positions.slice();
    const orphans = g.orphanFlags.slice();
    worker.postMessage(
      {
        type: "start",
        nodeCount: g.nodeCount,
        positions: pos.buffer,
        links: g.simLinks,
        orphanFlags: orphans.buffer,
        ringRadius: g.ringRadius,
        alpha,
      },
      [pos.buffer, orphans.buffer]
    );
  }

  private startMainThread(alpha: number) {
    const g = this.graph!;
    this.mainSim = createSimulation({
      nodeCount: g.nodeCount,
      positions: g.positions,
      links: g.simLinks,
      orphanFlags: g.orphanFlags,
      ringRadius: g.ringRadius,
      alpha,
    });
    const step = () => {
      if (this.destroyed || !this.mainSim) return;
      const done = tickBudget(this.mainSim, 4);
      copyPositions(this.mainSim.nodes, g.positions);
      this.tree = buildQuadtree(g);
      if (done) {
        this.mainSim = null;
        this.mainSimRaf = 0;
        this.onSimDone();
        return;
      }
      this.requestDraw();
      this.mainSimRaf = requestAnimationFrame(step);
    };
    this.mainSimRaf = requestAnimationFrame(step);
  }

  private onSimDone() {
    this.simHot = false;
    this.layingOut = false;
    this.cb.onLayoutHot(false);
    if (this.graph) {
      const positions: Record<string, [number, number]> = {};
      for (let i = 0; i < this.graph.nodeCount; i++) {
        positions[this.graph.ids[i]] = [this.graph.positions[i * 2], this.graph.positions[i * 2 + 1]];
      }
      this.cb.onLayoutSettled({ hash: this.graph.topologyHash, positions });
    }
    this.requestDraw();
  }

  private stopSim() {
    this.simHot = false;
    this.killWorker();
    this.mainSim = null;
    if (this.mainSimRaf) {
      cancelAnimationFrame(this.mainSimRaf);
      this.mainSimRaf = 0;
    }
  }

  private killWorker() {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
  }

  // ─── Draw loop ───

  private requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.hoverClock ? Math.min(now - this.hoverClock, 40) : 16;
    this.hoverClock = now;

    const step = dt / HOVER_MS;
    let anim = false;
    if (this.hoverT !== this.hoverTarget) {
      this.hoverT = this.hoverT < this.hoverTarget
        ? Math.min(this.hoverTarget, this.hoverT + step)
        : Math.max(this.hoverTarget, this.hoverT - step);
      anim = true;
    } else if (this.hoverTarget === 0 && this.hoverT === 0) {
      this.hoverIndex = -1;
    }
    if (this.labelT !== this.labelTarget) {
      this.labelT = this.labelT < this.labelTarget
        ? Math.min(this.labelTarget, this.labelT + step)
        : Math.max(this.labelTarget, this.labelT - step);
      anim = true;
    }
    this.animating = anim;

    if (this.graph) {
      drawGraph(this.ctx, {
        graph: this.graph,
        theme: this.theme,
        camera: { tx: this.tx, ty: this.ty, k: this.k },
        hoverIndex: this.hoverIndex,
        hoverT: this.hoverT,
        labelT: this.labelT,
        activeId: this.activeId,
        cssWidth: this.cssW,
        cssHeight: this.cssH,
        dpr: this.dpr,
      });
    }

    if (this.simHot || this.interacting || this.animating) this.requestDraw();
  }

  private updateLabelTarget() {
    this.labelTarget = this.k >= 0.55 ? 1 : 0;
    if (this.labelTarget !== this.labelT) this.requestDraw();
  }

  // ─── Input ───

  private worldFromEvent(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return [(sx - this.tx) / this.k, (sy - this.ty) / this.k];
  }

  private screenFromEvent(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const k2 = Math.max(K_MIN, Math.min(K_MAX, this.k * factor));
    const wx = (sx - this.tx) / this.k;
    const wy = (sy - this.ty) / this.k;
    this.k = k2;
    this.tx = sx - wx * k2;
    this.ty = sy - wy * k2;
    this.updateLabelTarget();
    this.requestDraw();
    this.emitCamera();
  }

  private emitCamera() {
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => {
      this.cb.onCameraChange({ tx: this.tx, ty: this.ty, k: this.k });
    }, 250);
  }

  private setHover(i: number) {
    if (i >= 0) {
      if (i === this.hoverIndex && this.hoverTarget === 1) return;
      this.hoverIndex = i;
      this.hoverTarget = 1;
      this.canvas.style.cursor = "pointer";
    } else {
      if (this.hoverTarget === 0) return;
      this.hoverTarget = 0;
      this.canvas.style.cursor = "default";
    }
    this.requestDraw();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [sx, sy] = this.screenFromEvent(e);
    const zoom = e.ctrlKey || e.metaKey;
    if (zoom) {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-dy * 0.002);
      this.zoomAt(sx, sy, factor);
    } else {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.requestDraw();
      this.emitCamera();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    const [wx, wy] = this.worldFromEvent(e);
    const idx = this.graph ? hitTest(this.tree, this.graph, wx, wy, this.k) : -1;
    this.pointer.down = true;
    this.pointer.button = e.button;
    this.pointer.moved = false;
    this.pointer.downIndex = idx;
    this.pointer.lastX = e.clientX;
    this.pointer.lastY = e.clientY;
    // Left-drag on empty canvas is reserved (future box-select). Pan: right-drag only.
    this.pointer.pan = e.button === 2;
    if (this.pointer.pan) {
      this.interacting = true;
      this.canvas.style.cursor = "grabbing";
      this.requestDraw();
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.pointer.down) {
      const dx = e.clientX - this.pointer.lastX;
      const dy = e.clientY - this.pointer.lastY;
      if (Math.hypot(dx, dy) > 3) this.pointer.moved = true;
      if (this.pointer.pan) {
        this.tx += dx;
        this.ty += dy;
        this.pointer.lastX = e.clientX;
        this.pointer.lastY = e.clientY;
        this.requestDraw();
      } else {
        this.pointer.lastX = e.clientX;
        this.pointer.lastY = e.clientY;
      }
      return;
    }
    const [wx, wy] = this.worldFromEvent(e);
    const idx = this.graph ? hitTest(this.tree, this.graph, wx, wy, this.k) : -1;
    this.setHover(idx);
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasPan = this.pointer.pan;
    const idx = this.pointer.downIndex;
    const moved = this.pointer.moved;
    const button = this.pointer.button;
    this.pointer.down = false;
    this.pointer.pan = false;
    this.pointer.button = -1;
    this.interacting = false;
    this.canvas.style.cursor = this.hoverIndex >= 0 ? "pointer" : "default";
    if (wasPan) this.emitCamera();
    if (button === 0 && !moved && idx >= 0 && this.graph) {
      const kind = this.graph.kinds[idx];
      this.cb.onNodeClick(this.graph.ids[idx], kind);
    }
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.requestDraw();
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onDblClick = (e: MouseEvent) => {
    const [wx, wy] = this.worldFromEvent(e);
    const idx = this.graph ? hitTest(this.tree, this.graph, wx, wy, this.k) : -1;
    if (idx < 0) this.zoomToFit();
  };

  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.lastGestureScale = 1;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    const ge = e as Event & { scale: number; clientX: number; clientY: number };
    const [sx, sy] = this.screenFromEvent(ge);
    const factor = ge.scale / this.lastGestureScale;
    this.lastGestureScale = ge.scale;
    this.zoomAt(sx, sy, factor);
  };

  private bind() {
    const c = this.canvas;
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("contextmenu", this.onContextMenu);
    c.addEventListener("dblclick", this.onDblClick);
    c.addEventListener("gesturestart", this.onGestureStart as EventListener);
    c.addEventListener("gesturechange", this.onGestureChange as EventListener);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
  }

  private unbind() {
    const c = this.canvas;
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("contextmenu", this.onContextMenu);
    c.removeEventListener("dblclick", this.onDblClick);
    c.removeEventListener("gesturestart", this.onGestureStart as EventListener);
    c.removeEventListener("gesturechange", this.onGestureChange as EventListener);
  }

  private resize() {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.pendingFit && this.graph) {
      this.pendingFit = false;
      this.zoomToFit();
      return;
    }
    this.requestDraw();
  }
}
