import { quadtree, type Quadtree } from "d3-quadtree";
import { KIND_FOLDER, KIND_NOTE, type BuiltGraph, type GraphTheme } from "./types";

export interface DrawState {
  graph: BuiltGraph;
  theme: GraphTheme;
  camera: { tx: number; ty: number; k: number };
  hoverIndex: number;
  hoverT: number;
  labelT: number;
  activeId: string | null;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

const GAP = 5;
const ZOOM_LOD = 0.3;
const LABEL_K = 0.55;
/** Max on-screen node radius (CSS px). World radii shrink past this as you zoom in. */
const MAX_SCREEN_R = 12;

function opticalR(worldR: number, k: number) {
  const cap = MAX_SCREEN_R / k;
  return worldR < cap ? worldR : cap;
}

function hexAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) {
    let r: number, g: number, b: number;
    if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    } else {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    }
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

function inView(x: number, y: number, r: number, minX: number, minY: number, maxX: number, maxY: number) {
  return x + r >= minX && x - r <= maxX && y + r >= minY && y - r <= maxY;
}

function edgeVisible(
  x1: number, y1: number, x2: number, y2: number,
  minX: number, minY: number, maxX: number, maxY: number
) {
  if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX)) return false;
  if ((y1 < minY && y2 < minY) || (y1 > maxY && y2 > maxY)) return false;
  return true;
}

function shortenCurve(
  x1: number, y1: number, r1: number,
  x2: number, y2: number, r2: number,
  gap: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  const sGap = r1 + gap;
  const tGap = r2 + gap;
  if (sGap + tGap >= len) return null;
  const sx = x1 + ux * sGap;
  const sy = y1 + uy * sGap;
  const tx = x2 - ux * tGap;
  const ty = y2 - uy * tGap;
  const bow = len * 0.08;
  const cx = (sx + tx) / 2 - uy * bow;
  const cy = (sy + ty) / 2 + ux * bow;
  return { sx, sy, cx, cy, tx, ty };
}

function neighborSet(graph: BuiltGraph, index: number): Set<number> {
  const set = new Set<number>([index]);
  const start = graph.adjOffsets[index];
  const end = graph.adjOffsets[index + 1];
  for (let i = start; i < end; i++) set.add(graph.adjIndices[i]);
  return set;
}

function truncLabel(s: string, max = 28) {
  return s.length > max ? s.slice(0, max - 1) + "…": s;
}

export function drawGraph(ctx: CanvasRenderingContext2D, state: DrawState) {
  const { graph, theme, camera, cssWidth, cssHeight, dpr, hoverIndex, hoverT, labelT, activeId } = state;
  const { tx, ty, k } = camera;
  const { positions, radii, kinds, nodeCount } = graph;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  if (nodeCount === 0) return;

  const pad = 24 / k;
  const minX = (0 - tx) / k - pad;
  const minY = (0 - ty) / k - pad;
  const maxX = (cssWidth - tx) / k + pad;
  const maxY = (cssHeight - ty) / k + pad;
  const lodLow = k < ZOOM_LOD;
  const lineW = 1 / k;
  const gap = Math.min(GAP, 5 / k);
  const dim = 1 - 0.8 * hoverT;
  const neigh = hoverIndex >= 0 ? neighborSet(graph, hoverIndex) : null;

  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(k, k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ── Base edges (batched) ──
  ctx.globalAlpha = dim;
  ctx.lineWidth = lineW;

  ctx.beginPath();
  ctx.strokeStyle = hexAlpha(theme.border, 0.28);
  for (let i = 0; i < graph.containCount; i++) {
    const a = graph.contains[i * 2];
    const b = graph.contains[i * 2 + 1];
    const x1 = positions[a * 2], y1 = positions[a * 2 + 1];
    const x2 = positions[b * 2], y2 = positions[b * 2 + 1];
    if (!edgeVisible(x1, y1, x2, y2, minX, minY, maxX, maxY)) continue;
    const c = shortenCurve(x1, y1, opticalR(radii[a], k), x2, y2, opticalR(radii[b], k), gap);
    if (!c) continue;
    ctx.moveTo(c.sx, c.sy);
    if (lodLow) ctx.lineTo(c.tx, c.ty);
    else ctx.quadraticCurveTo(c.cx, c.cy, c.tx, c.ty);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = hexAlpha(theme.foreground, 0.22);
  for (let i = 0; i < graph.linkCount; i++) {
    const a = graph.links[i * 2];
    const b = graph.links[i * 2 + 1];
    const x1 = positions[a * 2], y1 = positions[a * 2 + 1];
    const x2 = positions[b * 2], y2 = positions[b * 2 + 1];
    if (!edgeVisible(x1, y1, x2, y2, minX, minY, maxX, maxY)) continue;
    const c = shortenCurve(x1, y1, opticalR(radii[a], k), x2, y2, opticalR(radii[b], k), gap);
    if (!c) continue;
    ctx.moveTo(c.sx, c.sy);
    if (lodLow) ctx.lineTo(c.tx, c.ty);
    else ctx.quadraticCurveTo(c.cx, c.cy, c.tx, c.ty);
  }
  ctx.stroke();

  // ── Base nodes ──
  ctx.fillStyle = hexAlpha(theme.muted, 0.85);
  ctx.beginPath();
  for (let i = 0; i < nodeCount; i++) {
    if (kinds[i] !== KIND_FOLDER) continue;
    const x = positions[i * 2], y = positions[i * 2 + 1];
    const r = opticalR(radii[i], k);
    if (!inView(x, y, r, minX, minY, maxX, maxY)) continue;
    const s = r * 1.85;
    const rad = r * 0.35;
    ctx.roundRect(x - s / 2, y - s / 2, s, s, rad);
  }
  ctx.fill();
  if (!lodLow) {
    ctx.strokeStyle = hexAlpha(theme.border, 0.7);
    ctx.lineWidth = lineW;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.fillStyle = hexAlpha(theme.foreground, 0.55);
  for (let i = 0; i < nodeCount; i++) {
    if (kinds[i] !== KIND_NOTE) continue;
    const x = positions[i * 2], y = positions[i * 2 + 1];
    const r = opticalR(radii[i], k);
    if (!inView(x, y, r, minX, minY, maxX, maxY)) continue;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.globalAlpha = 1;

  // ── Active ring ──
  if (activeId) {
    const ai = graph.idToIndex.get(activeId);
    if (ai !== undefined) {
      const x = positions[ai * 2], y = positions[ai * 2 + 1];
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5 / k;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x, y, opticalR(radii[ai], k) + 3 / k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ── Hover highlight ──
  if (neigh && hoverT > 0.01) {
    ctx.globalAlpha = hoverT;
    ctx.lineWidth = 1.4 / k;
    ctx.strokeStyle = hexAlpha(theme.foreground, 0.7);
    ctx.beginPath();
    const arrowSize = 6 / k;
    const arrows: { tx: number; ty: number; cx: number; cy: number }[] = [];

    const drawHL = (arr: Uint32Array, count: number) => {
      for (let i = 0; i < count; i++) {
        const a = arr[i * 2];
        const b = arr[i * 2 + 1];
        if (!neigh.has(a) || !neigh.has(b)) continue;
        if (a !== hoverIndex && b !== hoverIndex) continue;
        const x1 = positions[a * 2], y1 = positions[a * 2 + 1];
        const x2 = positions[b * 2], y2 = positions[b * 2 + 1];
        const c = shortenCurve(x1, y1, opticalR(radii[a], k), x2, y2, opticalR(radii[b], k), gap);
        if (!c) continue;
        ctx.moveTo(c.sx, c.sy);
        ctx.quadraticCurveTo(c.cx, c.cy, c.tx, c.ty);
        arrows.push({ tx: c.tx, ty: c.ty, cx: c.cx, cy: c.cy });
      }
    };
    drawHL(graph.links, graph.linkCount);
    drawHL(graph.contains, graph.containCount);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = hexAlpha(theme.foreground, 0.85);
    ctx.lineWidth = 1.2 / k;
    for (const ar of arrows) {
      const ang = Math.atan2(ar.ty - ar.cy, ar.tx - ar.cx);
      ctx.moveTo(ar.tx, ar.ty);
      ctx.lineTo(ar.tx - arrowSize * Math.cos(ang - 0.5), ar.ty - arrowSize * Math.sin(ang - 0.5));
      ctx.moveTo(ar.tx, ar.ty);
      ctx.lineTo(ar.tx - arrowSize * Math.cos(ang + 0.5), ar.ty - arrowSize * Math.sin(ang + 0.5));
    }
    ctx.stroke();

    for (const i of neigh) {
      const x = positions[i * 2], y = positions[i * 2 + 1];
      const r = opticalR(radii[i], k);
      if (kinds[i] === KIND_FOLDER) {
        const s = r * 1.85;
        ctx.fillStyle = hexAlpha(theme.muted, 1);
        ctx.beginPath();
        ctx.roundRect(x - s / 2, y - s / 2, s, s, r * 0.35);
        ctx.fill();
        ctx.strokeStyle = theme.foreground;
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.fillStyle = hexAlpha(theme.foreground, 0.82);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (i === hoverIndex) {
          ctx.beginPath();
          ctx.fillStyle = hexAlpha(theme.foreground, 0.12);
          ctx.arc(x, y, r + 4 / k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // ── Labels in screen space ──
  const showLabels = k >= LABEL_K && labelT > 0.01;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = hexAlpha(theme.mutedFg, 0.9);

  if (showLabels) {
    ctx.globalAlpha = labelT * dim;
    for (let i = 0; i < nodeCount; i++) {
      const r = opticalR(radii[i], k);
      if (k * r < 4) continue;
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (!inView(x, y, r, minX, minY, maxX, maxY)) continue;
      if (neigh && !neigh.has(i)) continue;
      const sx = x * k + tx;
      const sy = y * k + ty + r * k + 4;
      ctx.font = `${kinds[i] === KIND_FOLDER ? 600 : 400} 11px ${theme.font}`;
      ctx.fillText(truncLabel(graph.labels[i]), sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  if (hoverIndex >= 0 && hoverT > 0.01) {
    const i = hoverIndex;
    const sx = positions[i * 2] * k + tx;
    const sy = positions[i * 2 + 1] * k + ty + opticalR(radii[i], k) * k + 4;
    ctx.globalAlpha = hoverT;
    ctx.font = `${kinds[i] === KIND_FOLDER ? 600 : 500} 12px ${theme.font}`;
    ctx.fillStyle = theme.foreground;
    ctx.fillText(truncLabel(graph.labels[i], 40), sx, sy);
    ctx.globalAlpha = 1;
  }
}

export function buildQuadtree(graph: BuiltGraph): Quadtree<number> {
  const idx: number[] = new Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) idx[i] = i;
  return quadtree<number>()
    .x((i) => graph.positions[i * 2])
    .y((i) => graph.positions[i * 2 + 1])
    .addAll(idx);
}

export function hitTest(
  tree: Quadtree<number> | null,
  graph: BuiltGraph,
  wx: number,
  wy: number,
  k: number
): number {
  if (!tree || graph.nodeCount === 0) return -1;
  const pad = 10 / k;
  const searchR = Math.min(18, MAX_SCREEN_R / k) + pad;
  const i = tree.find(wx, wy, searchR);
  if (i == null) return -1;
  const dx = graph.positions[i * 2] - wx;
  const dy = graph.positions[i * 2 + 1] - wy;
  const vis = opticalR(graph.radii[i], k);
  const extra = graph.kinds[i] === KIND_FOLDER ? vis * 0.4 : 0;
  const r = vis + extra + pad * 0.4;
  return dx * dx + dy * dy <= r * r ? i : -1;
}

export function boundsOf(graph: BuiltGraph): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (graph.nodeCount === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < graph.nodeCount; i++) {
    const x = graph.positions[i * 2];
    const y = graph.positions[i * 2 + 1];
    const r = graph.radii[i];
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function cameraFit(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  cssWidth: number,
  cssHeight: number
) {
  const w = Math.max(b.maxX - b.minX, 40);
  const h = Math.max(b.maxY - b.minY, 40);
  const pad = 48;
  const k = Math.min((cssWidth - pad * 2) / w, (cssHeight - pad * 2) / h, 2);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    k: Math.max(0.05, Math.min(4, k)),
    tx: cssWidth / 2 - cx * Math.max(0.05, Math.min(4, k)),
    ty: cssHeight / 2 - cy * Math.max(0.05, Math.min(4, k)),
  };
}

export function readTheme(el: HTMLElement): GraphTheme {
  const s = getComputedStyle(el);
  return {
    background: s.getPropertyValue("--background").trim() || "#ffffff",
    foreground: s.getPropertyValue("--foreground").trim() || "#171717",
    border: s.getPropertyValue("--border").trim() || "#e5e5e5",
    accent: s.getPropertyValue("--accent").trim() || "#000000",
    muted: s.getPropertyValue("--muted").trim() || "#a3a3a3",
    mutedFg: s.getPropertyValue("--muted-foreground").trim() || "#737373",
    font: s.fontFamily || "Inter, sans-serif",
  };
}
