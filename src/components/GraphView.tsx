"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { listAllBacklinks, getGraphLayout, saveGraphLayout, rebuildAllBacklinks } from "@/lib/db";
import { ancestorFolderIds, buildGraph, positionsToCache, seedPositions } from "@/lib/graph/buildGraph";
import { GraphEngine } from "@/lib/graph/engine";
import { loadCamera, loadLocalLayout, saveCamera, saveLocalLayout } from "@/lib/graph/persist";
import { KIND_FOLDER, type BuiltGraph, type LayoutCache } from "@/lib/graph/types";
import type { GraphCamera } from "@/lib/types";

export function GraphView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const graphRef = useRef<BuiltGraph | null>(null);
  const backlinksRef = useRef<{ source: string; target: string }[]>([]);
  const cameraHashRef = useRef<string>("");

  const closeGraph = useAppStore((s) => s.closeGraph);
  const openDocument = useAppStore((s) => s.openDocument);
  const expandFolders = useAppStore((s) => s.expandFolders);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);

  const [layingOut, setLayingOut] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  const persistCamera = useCallback((cam: { tx: number; ty: number; k: number }) => {
    const hash = cameraHashRef.current;
    if (!hash) return;
    saveCamera({ ...cam, hash } satisfies GraphCamera);
  }, []);

  const persistLayout = useCallback((cache: LayoutCache) => {
    saveLocalLayout(cache);
    void saveGraphLayout({ topologyHash: cache.hash, positions: cache.positions });
  }, []);

  const boot = useCallback(async (engine: GraphEngine) => {
    const { _dbDocuments, _dbFolders } = useAppStore.getState();
    const localLayout = loadLocalLayout();
    const savedCam = loadCamera();

    let backlinks: { source: string; target: string }[] = [];
    let dbLayout: LayoutCache | null = null;
    try {
      const [bl, layout] = await Promise.all([listAllBacklinks(), getGraphLayout()]);
      backlinks = bl;
      if (layout) dbLayout = { hash: layout.topologyHash, positions: layout.positions };
    } catch (err) {
      console.warn("[graph] failed to load", err);
    }
    if (engineRef.current !== engine) return;

    backlinksRef.current = backlinks;
    const graph = buildGraph(_dbDocuments, _dbFolders, backlinks);
    graphRef.current = graph;
    cameraHashRef.current = graph.topologyHash;

    const cache =
      localLayout?.hash === graph.topologyHash
        ? localLayout
        : dbLayout?.hash === graph.topologyHash
          ? dbLayout
          : localLayout ?? dbLayout;

    const complete = seedPositions(graph, cache);
    const hashMatch = cache?.hash === graph.topologyHash && complete;
    engine.setGraph(graph);

    if (savedCam && savedCam.hash === graph.topologyHash) {
      engine.setCamera(savedCam);
    } else {
      engine.zoomToFit();
    }

    const emptyLinks = graph.backlinkCount === 0 && graph.includedNoteCount > 5;
    setShowRebuild(emptyLinks);

    if (graph.nodeCount === 0) return;

    const alpha = hashMatch ? 0.1 : cache ? 0.45 : 1;
    engine.startLayout(alpha, !hashMatch && graph.nodeCount > 12);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const engine = new GraphEngine(canvas, wrap, {
      onNodeClick: (id, kind) => {
        if (kind === KIND_FOLDER) {
          const folders = useAppStore.getState()._dbFolders;
          expandFolders(ancestorFolderIds(id, folders));
          return;
        }
        void openDocument(id);
      },
      onLayoutSettled: persistLayout,
      onCameraChange: persistCamera,
      onLayoutHot: setLayingOut,
    });
    engine.setActiveId(useAppStore.getState().activeDocumentId);
    engineRef.current = engine;
    void boot(engine);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        persistCamera(engine.getCamera());
        closeGraph();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      persistCamera(engine.getCamera());
      window.removeEventListener("keydown", onKey);
      engine.destroy();
      engineRef.current = null;
    };
  }, [boot, closeGraph, expandFolders, openDocument, persistCamera, persistLayout]);

  useEffect(() => {
    engineRef.current?.setActiveId(activeDocumentId);
  }, [activeDocumentId]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const syncTheme = () => engineRef.current?.setThemeFrom(wrap);
    const mo = new MutationObserver(syncTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    return useAppStore.subscribe((s, prev) => {
      if (s._dbDocuments === prev._dbDocuments && s._dbFolders === prev._dbFolders) return;
      const engine = engineRef.current;
      const prevGraph = graphRef.current;
      if (!engine) return;

      const graph = buildGraph(s._dbDocuments, s._dbFolders, backlinksRef.current);
      if (prevGraph && graph.topologyHash === prevGraph.topologyHash) {
        graph.positions.set(prevGraph.positions);
        graphRef.current = graph;
        engine.setGraph(graph);
        return;
      }

      seedPositions(graph, prevGraph ? positionsToCache(prevGraph) : null);
      graphRef.current = graph;
      cameraHashRef.current = graph.topologyHash;
      engine.setGraph(graph);
      if (!prevGraph || prevGraph.nodeCount === 0) engine.zoomToFit();
      engine.startLayout(0.5, !prevGraph || prevGraph.nodeCount === 0);
    });
  }, []);

  const onRebuild = async () => {
    setRebuilding(true);
    setRebuildError(null);
    try {
      const docs = useAppStore.getState()._dbDocuments;
      await rebuildAllBacklinks(docs);
      const backlinks = await listAllBacklinks();
      backlinksRef.current = backlinks;
      const engine = engineRef.current;
      if (!engine) return;
      const { _dbDocuments, _dbFolders } = useAppStore.getState();
      const graph = buildGraph(_dbDocuments, _dbFolders, backlinks);
      const prev = graphRef.current ? positionsToCache(graphRef.current) : loadLocalLayout();
      seedPositions(graph, prev);
      graphRef.current = graph;
      cameraHashRef.current = graph.topologyHash;
      engine.setGraph(graph);
      engine.zoomToFit();
      engine.startLayout(0.8, graph.nodeCount > 12);
      setShowRebuild(graph.backlinkCount === 0 && graph.includedNoteCount > 5);
    } catch (err) {
      console.warn("[graph] rebuild failed", err);
      setRebuildError("Couldn't rebuild links. Try again.");
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-background select-none overscroll-none">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ touchAction: "none" }}
      />

      {layingOut && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
          <Loader2 size={12} className="animate-spin" />
          Laying out…
        </div>
      )}

      {showRebuild && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-md w-[calc(100%-2rem)] rounded-md border border-border bg-background/95 px-3 py-2.5 text-[12px] text-muted-foreground shadow-sm">
          <p className="leading-snug">
            No links found. Notes connect when they mention each other with{" "}
            <code className="text-[11px] bg-black/[0.06] px-1 rounded">[[wikilinks]]</code> or page mentions.
            Older notes may need a rebuild.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuilding}
              className="px-2 py-1 rounded-md bg-black/[0.08] hover:bg-black/[0.12] text-foreground text-[11px] font-medium disabled:opacity-50"
            >
              {rebuilding ? "Rebuilding…" : "Rebuild links"}
            </button>
            {rebuildError && <span className="text-[11px] text-red-500">{rebuildError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default GraphView;
