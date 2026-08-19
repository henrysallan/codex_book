"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { downloadDriveFile, setDriveToken } from "@/lib/googleDrive";
import {
  fetchPdfAnnotations,
  createPdfAnnotation,
  updatePdfAnnotation,
  deletePdfAnnotation,
} from "@/lib/db";
import { anchorFromSelection, resolveAnchor, type ResolvedHighlight } from "@/lib/pdfAnchor";
import { HIGHLIGHT_COLORS, PdfSelectionMenu } from "./PdfSelectionMenu";
import { PdfAnnotationPopover } from "./PdfAnnotationPopover";
import { useAuth } from "@/lib/auth";
import type { PdfAnnotation, PdfAnnotationColor, PdfAnnotationType, AnnotationMessage } from "@/lib/types";
import {
  Loader2,
  Download,
  ExternalLink,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  ChevronUp,
  ChevronDown,
  Highlighter,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

/* ── Memoised page wrapper ──────────────────────────────────
   react-pdf's TextLayer has a useLayoutEffect whose deps include
   the onRenderTextLayerSuccess / onRenderError callbacks.  If those
   are new arrow-functions on every parent render the effect re-runs
   and starts with `layer.innerHTML = ''`, wiping all text spans.
   Wrapping each page in React.memo with stable callbacks avoids this. */
const PdfPageView = memo(function PdfPageView({
  pageNum,
  scale,
  onTextLayerRendered,
}: {
  pageNum: number;
  scale: number;
  onTextLayerRendered: (pageNum: number) => void;
}) {
  const handleTextLayerSuccess = useCallback(() => {
    onTextLayerRendered(pageNum);
  }, [pageNum, onTextLayerRendered]);

  return (
    <Page
      pageNumber={pageNum}
      scale={scale}
      renderAnnotationLayer={false}
      renderTextLayer={true}
      onRenderTextLayerSuccess={handleTextLayerSuccess}
      loading={
        <div className="flex items-center justify-center py-24">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      }
    />
  );
});

interface FileViewerProps {
  fileId: string;
  fileName: string;
  mimeType: string;
  webViewLink: string | null;
}

export function FileViewer({ fileId, fileName, mimeType, webViewLink }: FileViewerProps) {
  const { providerToken } = useAuth();

  // ── File loading state ───────────────────────────────────
  const [fileData, setFileData] = useState<{ blob: Blob; url: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── PDF state ────────────────────────────────────────────
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // ── Annotations state ────────────────────────────────────
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [resolvedHighlights, setResolvedHighlights] = useState<ResolvedHighlight[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<{
    position: { x: number; y: number };
  } | null>(null);
  const [activePopover, setActivePopover] = useState<{
    annotation: PdfAnnotation;
    position: { x: number; y: number };
  } | null>(null);

  // Track which pages have rendered their text layer
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());

  // Annotation cycling
  const [activeAnnotationIndex, setActiveAnnotationIndex] = useState<number>(-1);

  // Ref to always have latest resolvedHighlights inside event listeners
  const resolvedHighlightsRef = useRef<ResolvedHighlight[]>([]);
  useEffect(() => { resolvedHighlightsRef.current = resolvedHighlights; }, [resolvedHighlights]);

  // Keep Drive token in sync
  useEffect(() => {
    if (providerToken) setDriveToken(providerToken);
  }, [providerToken]);

  // ── Load file ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setNumPages(0);
    setCurrentPage(1);
    setAnnotations([]);
    setResolvedHighlights([]);
    setRenderedPages(new Set());

    downloadDriveFile(fileId)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setFileData({ blob, url });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [fileId]);

  // Clean up blob URL
  useEffect(() => {
    return () => { if (fileData?.url) URL.revokeObjectURL(fileData.url); };
  }, [fileData]);

  // ── Load annotations from DB ─────────────────────────────
  useEffect(() => {
    if (!fileData) return;
    fetchPdfAnnotations(fileId)
      .then(setAnnotations)
      .catch((err) => console.error("Failed to load PDF annotations:", err));
  }, [fileId, fileData]);

  // ── Resolve highlights whenever annotations or rendered pages change ──
  useEffect(() => {
    if (!containerRef.current || annotations.length === 0) {
      setResolvedHighlights([]);
      return;
    }

    // Small delay to let text layers finish rendering
    const timer = setTimeout(() => {
      const resolved: ResolvedHighlight[] = [];
      for (const ann of annotations) {
        if (!renderedPages.has(ann.anchor.pageNumber)) continue;
        const r = resolveAnchor(ann, containerRef.current!);
        if (r) resolved.push(r);
      }
      setResolvedHighlights(resolved);
    }, 100);

    return () => clearTimeout(timer);
  }, [annotations, renderedPages]);

  // Keep activeAnnotationIndex in range when highlights change
  useEffect(() => {
    if (resolvedHighlights.length === 0) {
      setActiveAnnotationIndex(-1);
    } else if (activeAnnotationIndex >= resolvedHighlights.length) {
      setActiveAnnotationIndex(resolvedHighlights.length - 1);
    } else if (activeAnnotationIndex < 0 && resolvedHighlights.length > 0) {
      setActiveAnnotationIndex(0);
    }
  }, [resolvedHighlights.length, activeAnnotationIndex]);

  // ── Track current page on scroll ─────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    function onScroll() {
      const containerRect = container!.getBoundingClientRect();
      const midY = containerRect.top + containerRect.height / 2;
      let closestPage = 1;
      let closestDist = Infinity;

      pageRefs.current.forEach((el, pageNum) => {
        const rect = el.getBoundingClientRect();
        const pageMid = rect.top + rect.height / 2;
        const dist = Math.abs(pageMid - midY);
        if (dist < closestDist) {
          closestDist = dist;
          closestPage = pageNum;
        }
      });

      setCurrentPage(closestPage);
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [numPages]);

  // ── Handle text selection → show menu ────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function onMouseUp(e: MouseEvent) {
      // Small delay so the selection settles
      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) {
          // No selection — check if the click hit a resolved highlight
          for (const rh of resolvedHighlightsRef.current) {
            const pageEl = pageRefs.current.get(rh.annotation.anchor.pageNumber);
            if (!pageEl) continue;
            const pageRect = pageEl.getBoundingClientRect();
            for (const rect of rh.rects) {
              const absLeft = pageRect.left + rect.x;
              const absTop = pageRect.top + rect.y;
              if (
                e.clientX >= absLeft &&
                e.clientX <= absLeft + rect.width &&
                e.clientY >= absTop &&
                e.clientY <= absTop + rect.height
              ) {
                setActivePopover({
                  annotation: rh.annotation,
                  position: { x: e.clientX, y: e.clientY },
                });
                return;
              }
            }
          }
          return;
        }

        const result = anchorFromSelection(selection);
        if (!result) return;

        // Position the menu at the top-center of the selection
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setSelectionMenu({
          position: { x: rect.left + rect.width / 2, y: rect.top },
        });
      }, 10);
    }

    container.addEventListener("mouseup", onMouseUp);
    return () => container.removeEventListener("mouseup", onMouseUp);
  }, [fileData]);

  // ── Annotation actions ───────────────────────────────────

  const handleCreateAnnotation = useCallback(
    async (type: PdfAnnotationType, color: PdfAnnotationColor) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const result = anchorFromSelection(selection);
      if (!result) return;

      try {
        const ann = await createPdfAnnotation({
          driveFileId: fileId,
          color,
          type,
          anchor: result.anchor,
          note: type === "note" ? "" : null,
        });

        setAnnotations((prev) => [...prev, ann]);

        // If note or chat, immediately open the popover
        if (type === "note" || type === "chat") {
          const rects = result.rects;
          if (rects.length > 0) {
            const last = rects[rects.length - 1];
            setActivePopover({
              annotation: ann,
              position: { x: last.left + last.width / 2, y: last.bottom },
            });
          }
        }
      } catch (err) {
        console.error("Failed to create annotation:", err);
      }

      // Clear selection and menu
      selection.removeAllRanges();
      setSelectionMenu(null);
    },
    [fileId]
  );

  const handleDeleteAnnotation = useCallback(async (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setActivePopover(null);
    try {
      await deletePdfAnnotation(id);
    } catch (err) {
      console.error("Failed to delete annotation:", err);
    }
  }, []);

  const handleUpdateColor = useCallback(
    async (id: string, color: PdfAnnotationColor) => {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, color } : a))
      );
      if (activePopover?.annotation.id === id) {
        setActivePopover((p) =>
          p ? { ...p, annotation: { ...p.annotation, color } } : null
        );
      }
      try {
        await updatePdfAnnotation(id, { color });
      } catch (err) {
        console.error("Failed to update annotation color:", err);
      }
    },
    [activePopover]
  );

  const handleUpdateNote = useCallback(async (id: string, note: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, note } : a))
    );
    try {
      await updatePdfAnnotation(id, { note });
    } catch (err) {
      console.error("Failed to update annotation note:", err);
    }
  }, []);

  const handleSendChatMessage = useCallback(
    async (id: string, content: string) => {
      const userMsg: AnnotationMessage = {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };

      // Optimistic update
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, messages: [...a.messages, userMsg] } : a
        )
      );
      setActivePopover((p) => {
        if (p?.annotation.id !== id) return p;
        return {
          ...p,
          annotation: { ...p.annotation, messages: [...p.annotation.messages, userMsg] },
        };
      });

      // Persist user message
      const ann = annotations.find((a) => a.id === id);
      const updatedMessages = [...(ann?.messages ?? []), userMsg];

      try {
        await updatePdfAnnotation(id, { messages: updatedMessages });
      } catch (err) {
        console.error("Failed to persist chat message:", err);
      }

      // Call AI endpoint
      try {
        const res = await fetch("/api/ai/annotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            annotationId: id,
            documentId: fileId,
            highlightedText: ann?.anchor.exact ?? "",
            messages: updatedMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
        });

        if (!res.ok) throw new Error(`API error: ${res.status}`);

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "text") accumulated += event.content;
            } catch {
              // skip malformed
            }
          }
        }

        if (accumulated) {
          const assistantMsg: AnnotationMessage = {
            role: "assistant",
            content: accumulated,
            timestamp: new Date().toISOString(),
          };
          const allMessages = [...updatedMessages, assistantMsg];

          setAnnotations((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, messages: allMessages } : a
            )
          );
          setActivePopover((p) => {
            if (p?.annotation.id !== id) return p;
            return {
              ...p,
              annotation: { ...p.annotation, messages: allMessages },
            };
          });

          await updatePdfAnnotation(id, { messages: allMessages });
        }
      } catch (err) {
        console.error("AI annotation chat failed:", err);
        const errorMsg: AnnotationMessage = {
          role: "assistant",
          content: "Sorry, I couldn't generate a response. Please try again.",
          timestamp: new Date().toISOString(),
        };
        const allMessages = [...updatedMessages, errorMsg];
        setAnnotations((prev) =>
          prev.map((a) => (a.id === id ? { ...a, messages: allMessages } : a))
        );
        setActivePopover((p) => {
          if (p?.annotation.id !== id) return p;
          return { ...p, annotation: { ...p.annotation, messages: allMessages } };
        });
        await updatePdfAnnotation(id, { messages: allMessages }).catch(() => {});
      }
    },
    [annotations, fileId]
  );

  // ── Download ─────────────────────────────────────────────
  const handleDownload = useCallback(async () => {
    try {
      const blob = fileData?.blob ?? (await downloadDriveFile(fileId));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [fileId, fileName, fileData]);

  // ── Annotation cycling ───────────────────────────────────
  const scrollToAnnotation = useCallback((index: number) => {
    if (resolvedHighlights.length === 0) return;
    const clamped = ((index % resolvedHighlights.length) + resolvedHighlights.length) % resolvedHighlights.length;
    setActiveAnnotationIndex(clamped);

    const rh = resolvedHighlights[clamped];
    const pageEl = pageRefs.current.get(rh.annotation.anchor.pageNumber);
    if (!pageEl || !containerRef.current) return;

    // Scroll to the first rect of this highlight, centered in the viewport
    const containerRect = containerRef.current.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const firstRect = rh.rects[0];
    if (!firstRect) return;

    const targetScrollTop =
      pageEl.offsetTop + firstRect.y - containerRect.height / 3;
    containerRef.current.scrollTo({ top: targetScrollTop, behavior: "smooth" });

    // Also open the popover for this annotation
    const absX = pageRect.left + firstRect.x + firstRect.width / 2;
    const absY = pageRect.top + firstRect.y + firstRect.height;
    setActivePopover({ annotation: rh.annotation, position: { x: absX, y: absY } });
  }, [resolvedHighlights]);

  const goToPrevAnnotation = useCallback(() => {
    scrollToAnnotation(activeAnnotationIndex - 1);
  }, [activeAnnotationIndex, scrollToAnnotation]);

  const goToNextAnnotation = useCallback(() => {
    scrollToAnnotation(activeAnnotationIndex + 1);
  }, [activeAnnotationIndex, scrollToAnnotation]);

  // ── PDF callbacks ────────────────────────────────────────
  function onDocumentLoadSuccess({ numPages: n }: { numPages: number }) {
    setNumPages(n);
  }

  const onPageRenderSuccess = useCallback((pageNum: number) => {
    setRenderedPages((prev) => {
      if (prev.has(pageNum)) return prev; // same ref ⇒ no re-render
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  }, []);

  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");

  // ── Loading state ────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <Loader2 size={32} className="animate-spin" />
        <p className="text-sm">Loading {fileName}…</p>
      </div>
    );
  }

  if (error || !fileData) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <AlertTriangle size={32} />
        <p className="text-sm">{error || "Failed to load file"}</p>
        <div className="flex gap-2">
          {webViewLink && (
            <a href={webViewLink} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-border hover:border-black/20 transition-colors">
              <ExternalLink size={12} /> Open in Drive
            </a>
          )}
          <button onClick={handleDownload}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-border hover:border-black/20 transition-colors">
            <Download size={12} /> Download
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Toolbar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-white shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {fileName}
          </span>
          {isPdf && numPages > 0 && (
            <span className="text-[10px] text-muted-foreground bg-black/5 rounded px-1.5 py-0.5">
              {currentPage} / {numPages}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Annotation cycling */}
          {isPdf && annotations.length > 0 && (
            <div className="flex items-center gap-0.5 mr-2 border-r border-border pr-2">
              <Highlighter size={13} className="text-muted-foreground mr-0.5" />
              <button
                onClick={goToPrevAnnotation}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground disabled:opacity-30"
                disabled={resolvedHighlights.length === 0}
                title="Previous annotation"
              >
                <ChevronUp size={14} />
              </button>
              <span className="text-[10px] text-muted-foreground w-auto min-w-[2rem] text-center tabular-nums">
                {resolvedHighlights.length === 0
                  ? "0"
                  : `${activeAnnotationIndex + 1} / ${resolvedHighlights.length}`}
              </span>
              <button
                onClick={goToNextAnnotation}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground disabled:opacity-30"
                disabled={resolvedHighlights.length === 0}
                title="Next annotation"
              >
                <ChevronDown size={14} />
              </button>
            </div>
          )}

          {(isPdf || isImage) && (
            <div className="flex items-center gap-0.5 mr-2">
              <button onClick={() => setZoom((z) => Math.max(25, z - 25))}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground" title="Zoom out">
                <ZoomOut size={14} />
              </button>
              <span className="text-[10px] text-muted-foreground w-8 text-center">{zoom}%</span>
              <button onClick={() => setZoom((z) => Math.min(300, z + 25))}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground" title="Zoom in">
                <ZoomIn size={14} />
              </button>
            </div>
          )}

          <button onClick={handleDownload}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-black/5 text-muted-foreground">
            <Download size={12} /> Download
          </button>
          {webViewLink && (
            <a href={webViewLink} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-black/5 text-muted-foreground">
              <ExternalLink size={12} /> Drive
            </a>
          )}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────── */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto bg-neutral-100">
        {isPdf ? (
          <div className="flex flex-col items-center py-6 gap-4">
            <Document
              file={fileData.url}
              onLoadSuccess={onDocumentLoadSuccess}
              loading={
                <div className="flex items-center gap-2 text-muted-foreground py-12">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Rendering PDF…</span>
                </div>
              }
              error={
                <div className="flex flex-col items-center gap-2 text-muted-foreground py-12">
                  <AlertTriangle size={24} />
                  <span className="text-sm">Failed to render PDF</span>
                </div>
              }
            >
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <div
                  key={pageNum}
                  ref={(el) => {
                    if (el) pageRefs.current.set(pageNum, el);
                    else pageRefs.current.delete(pageNum);
                  }}
                  className="mb-4 shadow-lg relative"
                >
                  <PdfPageView
                    pageNum={pageNum}
                    scale={zoom / 100}
                    onTextLayerRendered={onPageRenderSuccess}
                  />
                  {/* Highlight overlays — z-index 1, below textLayer's z-index 2 */}
                  {resolvedHighlights
                    .filter((rh) => rh.annotation.anchor.pageNumber === pageNum)
                    .map((rh) =>
                      rh.rects.map((rect, ri) => (
                        <div
                          key={`${rh.annotation.id}-${ri}`}
                          style={{
                            position: "absolute",
                            left: rect.x,
                            top: rect.y,
                            width: rect.width,
                            height: rect.height,
                            backgroundColor: HIGHLIGHT_COLORS[rh.annotation.color],
                            pointerEvents: "none",
                            borderRadius: 2,
                            zIndex: 1,
                            mixBlendMode: "multiply" as const,
                            ...(ri === 0 && rh.annotation.type !== "highlight"
                              ? {
                                  borderLeft: `3px solid ${
                                    rh.annotation.type === "note"
                                      ? "rgba(0,0,0,0.2)"
                                      : "rgba(59,130,246,0.5)"
                                  }`,
                                }
                              : {}),
                          }}
                        />
                      ))
                    )}
                </div>
              ))}
            </Document>
          </div>
        ) : isImage ? (
          <div className="flex items-center justify-center p-4 min-h-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileData.url}
              alt={fileName}
              className="max-w-full shadow-lg rounded"
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: "center center" }}
            />
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <p className="text-sm">Preview not available for this file type.</p>
            <div className="flex gap-2">
              <button onClick={handleDownload}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-border hover:border-black/20">
                <Download size={12} /> Download
              </button>
              {webViewLink && (
                <a href={webViewLink} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-border hover:border-black/20">
                  <ExternalLink size={12} /> Open in Drive
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Selection menu (floating) ───────────────────── */}
      {selectionMenu && (
        <PdfSelectionMenu
          position={selectionMenu.position}
          onAction={handleCreateAnnotation}
          onDismiss={() => {
            setSelectionMenu(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}

      {/* ── Annotation popover (floating) ───────────────── */}
      {activePopover && (
        <PdfAnnotationPopover
          annotation={activePopover.annotation}
          position={activePopover.position}
          onClose={() => setActivePopover(null)}
          onDelete={handleDeleteAnnotation}
          onUpdateColor={handleUpdateColor}
          onUpdateNote={handleUpdateNote}
          onSendChatMessage={handleSendChatMessage}
        />
      )}
    </div>
  );
}
