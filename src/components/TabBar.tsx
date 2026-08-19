"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { X, FileText, ChevronLeft, ChevronRight, Home, HardDrive } from "lucide-react";

interface ContextMenu {
  x: number;
  y: number;
  tabId: string;
}

export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const goBack = useAppStore((s) => s.goBack);
  const goForward = useAppStore((s) => s.goForward);
  const canGoBack = useAppStore((s) => s.canGoBack);
  const canGoForward = useAppStore((s) => s.canGoForward);

  const isHome = activeDocumentId === null;

  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ctxMenu]);

  const closeAllTabs = useCallback(() => {
    const tabs = useAppStore.getState().openTabs;
    tabs.forEach((t) => closeTab(t.documentId));
    setCtxMenu(null);
  }, [closeTab]);

  const closeOtherTabs = useCallback(
    (keepId: string) => {
      const tabs = useAppStore.getState().openTabs;
      tabs.forEach((t) => {
        if (t.documentId !== keepId) closeTab(t.documentId);
      });
      setCtxMenu(null);
    },
    [closeTab]
  );

  const closeTabsToRight = useCallback(
    (fromId: string) => {
      const tabs = useAppStore.getState().openTabs;
      const idx = tabs.findIndex((t) => t.documentId === fromId);
      if (idx === -1) return;
      tabs.slice(idx + 1).forEach((t) => closeTab(t.documentId));
      setCtxMenu(null);
    },
    [closeTab]
  );

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 overflow-x-auto border-b border-border bg-white">
      {/* Back / Forward */}
      <div className="flex items-center gap-0.5 shrink-0 mr-1">
        <button
          onClick={() => goBack()}
          disabled={!canGoBack()}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Go back"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={() => goForward()}
          disabled={!canGoForward()}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Go forward"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Home pill */}
      <div
        onClick={() => useAppStore.setState({ activeDocumentId: null, activeDocument: null, activeAnnotation: null })}
        className={`flex items-center justify-center px-3 py-1 rounded-full border cursor-pointer transition-colors shrink-0 bg-blue-50 ${
          isHome
            ? "border-blue-200"
            : "border-blue-100 hover:border-blue-200"
        }`}
        title="Home"
      >
        <Home size={10} className="text-blue-400" />
      </div>
      {openTabs.map((tab) => {
        const isActive = tab.documentId === activeDocumentId;
        return (
          <div
            key={tab.documentId}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full border cursor-pointer transition-colors shrink-0 ${
              isActive
                ? "border-black/20 bg-white"
                : "border-border hover:border-black/15 bg-transparent"
            }`}
            onClick={() => {
              if (tab.driveFile) {
                // Drive file tabs just switch the active tab ID directly
                useAppStore.setState({
                  activeDocumentId: tab.documentId,
                  activeDocument: null,
                  activeAnnotation: null,
                });
              } else {
                setActiveTab(tab.documentId);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.documentId });
            }}
          >
            {tab.driveFile ? (
              <HardDrive size={10} className="text-muted-foreground" />
            ) : (
              <FileText size={10} className="text-muted-foreground" />
            )}
            <span className="text-[10px] text-foreground whitespace-nowrap max-w-[120px] truncate">
              {tab.title}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.documentId);
              }}
              className="ml-1 p-0.5 rounded-full hover:bg-black/10 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-white shadow-lg py-1 text-xs"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-black/5 text-foreground transition-colors"
            onClick={() => {
              closeTab(ctxMenu.tabId);
              setCtxMenu(null);
            }}
          >
            Close
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-black/5 text-foreground transition-colors"
            onClick={() => closeOtherTabs(ctxMenu.tabId)}
          >
            Close Others
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-black/5 text-foreground transition-colors"
            onClick={() => closeTabsToRight(ctxMenu.tabId)}
          >
            Close to the Right
          </button>
          <div className="my-1 border-t border-border" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-black/5 text-foreground transition-colors"
            onClick={closeAllTabs}
          >
            Close All
          </button>
        </div>
      )}
    </div>
  );
}
