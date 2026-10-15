"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/lib/store";
import type { DocType } from "@/lib/types";
import {
  ChevronRight,
  ChevronLeft,
  FileText,
  FolderIcon,
  Plus,
  Settings,
  MessageSquare,
  CheckSquare,
  CalendarDays,
  Zap,
  LayoutGrid,
  Upload,
  HardDrive,
  ListFilter,
  ArrowUp,
  ArrowDown,
  Waypoints,
} from "lucide-react";
import { useDriveShortcut } from "@/components/DriveFolder";
import { ImportDialog } from "@/components/ImportDialog";
import { FileTree, type FileTreeHandle } from "@/components/FileTree";
import { SORT_MODES, type SortDir, type SortMode } from "@/lib/fileTree";

const PINNED_DOC_ORDER: DocType[] = ["daily_parent", "todo", "quick_note_parent"];

function pinnedDocIcon(docType: DocType) {
  if (docType === "todo") return <CheckSquare size={14} />;
  if (docType === "daily_parent") return <CalendarDays size={14} />;
  if (docType === "quick_note_parent") return <Zap size={14} />;
  return <FileText size={14} />;
}

type PinnedSource = {
  _dbDocuments: { id: string; title: string; doc_type: DocType; folder_id: string | null; parent_document_id: string | null }[];
};

let pinnedCache: { docs: PinnedSource["_dbDocuments"] | null; signature: string } = { docs: null, signature: "" };

/** Root-level system docs as a primitive, so the shell only re-renders when they
 *  change. Zustand runs selectors on every store update, so cache per docs array. */
function selectPinnedSignature(s: PinnedSource) {
  if (pinnedCache.docs === s._dbDocuments) return pinnedCache.signature;
  const signature = PINNED_DOC_ORDER.map((type) => {
    const d = s._dbDocuments.find((x) => x.doc_type === type && !x.folder_id && !x.parent_document_id);
    return d ? `${type}\u0000${d.id}\u0000${d.title}` : "";
  }).join("\u0001");
  pinnedCache = { docs: s._dbDocuments, signature };
  return signature;
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable
  }
}

export function Sidebar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const openDocument = useAppStore((s) => s.openDocument);
  const createDocument = useAppStore((s) => s.createDocument);
  const dbFolders = useAppStore((s) => s._dbFolders);
  const pinnedSignature = useAppStore(selectPinnedSignature);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const toggleGraph = useAppStore((s) => s.toggleGraph);
  const isGraphOpen = useAppStore((s) => s.isGraphOpen);
  const { visible: driveVisible, openDrive } = useDriveShortcut();

  const treeRef = useRef<FileTreeHandle>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  // The sidebar only renders client-side (after auth + store init), so these
  // read localStorage up front instead of flashing the defaults first.
  const [isCollapsed, setIsCollapsed] = useState(
    () => readPref("cortex:sidebarCollapsed", ["true", "false"] as const, "false") === "true"
  );
  const [focusedFolderState, setFocusedFolderId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    readPref("cortex:sidebarSortMode", SORT_MODES.map((m) => m.value), "manual")
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    readPref("cortex:sidebarSortDir", ["asc", "desc"] as const, "asc")
  );
  const pendingNewFolder = useRef(false);

  // Leave focus mode if the focused folder disappears.
  const focusedFolderId =
    focusedFolderState && dbFolders.some((f) => f.id === focusedFolderState)
      ? focusedFolderState
      : null;

  const setCollapsed = useCallback((next: boolean) => {
    setIsCollapsed(next);
    writePref("cortex:sidebarCollapsed", String(next));
  }, []);

  // Collapse once the first time chat opens, to make room for it.
  const didAutoCollapseForChat = useRef(false);
  useEffect(() => {
    if (!isChatOpen || didAutoCollapseForChat.current) return;
    didAutoCollapseForChat.current = true;
    setCollapsed(true);
  }, [isChatOpen, setCollapsed]);

  const startCreateFolder = useCallback(() => {
    if (isCollapsed) {
      // The tree mounts on expand; open the draft row once it exists.
      pendingNewFolder.current = true;
      setCollapsed(false);
      return;
    }
    treeRef.current?.startNewFolder(focusedFolderId);
  }, [isCollapsed, focusedFolderId, setCollapsed]);

  useEffect(() => {
    if (isCollapsed || !pendingNewFolder.current) return;
    pendingNewFolder.current = false;
    treeRef.current?.startNewFolder(focusedFolderId);
  }, [isCollapsed, focusedFolderId]);

  const createDocumentInContext = useCallback(
    (docType: DocType = "note") => {
      void createDocument(focusedFolderId ?? null, docType);
    },
    [focusedFolderId, createDocument]
  );

  const handleSortModeChange = useCallback((mode: SortMode) => {
    setSortMode(mode);
    writePref("cortex:sidebarSortMode", mode);
  }, []);

  const handleSortDirChange = useCallback((dir: SortDir) => {
    setSortDir(dir);
    writePref("cortex:sidebarSortDir", dir);
  }, []);

  const focusedFolderPath = useMemo(() => {
    if (!focusedFolderId) return [];
    const path: { id: string; name: string }[] = [];
    const folderMap = new Map(dbFolders.map((f) => [f.id, f]));
    const seen = new Set<string>();
    let currentId: string | null = focusedFolderId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const folder = folderMap.get(currentId);
      if (!folder) break;
      path.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parent_id;
    }
    return path;
  }, [focusedFolderId, dbFolders]);

  const pinnedDocs = useMemo(
    () =>
      pinnedSignature
        .split("\u0001")
        .filter(Boolean)
        .map((entry) => {
          const [docType, id, title] = entry.split("\u0000");
          return { docType: docType as DocType, id, title };
        }),
    [pinnedSignature]
  );

  return (
    <>
      <div className="shrink-0 h-full p-2">
      <div
        className={`h-full flex flex-col bg-sidebar-bg overflow-hidden rounded-md border border-border transition-[width] duration-200 ease-out ${
          isCollapsed ? "w-10" : "w-[260px]"
        }`}
      >
        {isCollapsed ? (
          <div className="flex flex-col h-full items-center py-3">
            <button
              onClick={() => setCollapsed(false)}
              className="p-1 rounded hover:bg-ink/5 text-muted-foreground hover:text-foreground transition-colors"
              title="Expand sidebar"
            >
              <ChevronRight size={16} />
            </button>
            <div className="flex flex-col items-center gap-1 mt-2">
              <IconTooltipButton label="New page" onClick={() => createDocumentInContext()}>
                <Plus size={14} />
              </IconTooltipButton>
              <IconTooltipButton label="New moodboard" onClick={() => createDocumentInContext("moodboard")}>
                <LayoutGrid size={14} />
              </IconTooltipButton>
              <IconTooltipButton label="New folder" onClick={startCreateFolder}>
                <FolderIcon size={14} />
              </IconTooltipButton>
              <IconTooltipButton label="Import" onClick={() => setIsImportOpen(true)}>
                <Upload size={14} />
              </IconTooltipButton>
              <IconTooltipButton label="Graph" onClick={toggleGraph} active={isGraphOpen}>
                <Waypoints size={14} />
              </IconTooltipButton>
            </div>
            <div className="flex-1" />
            <div className="flex flex-col items-center gap-1">
              <IconTooltipButton label="AI Chat" onClick={toggleChat} active={isChatOpen}>
                <MessageSquare size={14} />
              </IconTooltipButton>
              <IconTooltipButton label="Settings" onClick={onOpenSettings}>
                <Settings size={14} />
              </IconTooltipButton>
            </div>
          </div>
        ) : (
          <>
            {/* Logo */}
            <div className="px-2 pt-2 pb-1">
              <div className="flex items-center justify-between gap-2 rounded-md bg-ink/[0.06] px-2.5 py-1.5">
                <span className="text-[15px] font-bold leading-none text-foreground">Book</span>
                <button
                  onClick={() => setCollapsed(true)}
                  className="p-0.5 rounded hover:bg-ink/5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  title="Collapse sidebar"
                >
                  <ChevronLeft size={15} />
                </button>
              </div>
            </div>

            {(pinnedDocs.length > 0 || driveVisible) && (
              <div className="flex items-center gap-1 px-2 pb-1">
                {pinnedDocs.map((doc) => (
                  <IconTooltipButton
                    key={doc.id}
                    label={doc.title || "Untitled"}
                    onClick={() => openDocument(doc.id)}
                    active={activeDocumentId === doc.id}
                    framed
                  >
                    {pinnedDocIcon(doc.docType)}
                  </IconTooltipButton>
                ))}
                {driveVisible && (
                  <IconTooltipButton
                    label="Google Drive"
                    onClick={() => { void openDrive(); }}
                    active={!!activeDocumentId?.startsWith("drive:")}
                    framed
                  >
                    <HardDrive size={14} />
                  </IconTooltipButton>
                )}
              </div>
            )}

            {/* File tree */}
            <div className="flex-1 min-h-0 flex flex-col px-1 pt-1">
              <SidebarFolderBreadcrumb
                path={focusedFolderPath}
                onNavigate={setFocusedFolderId}
                sortMode={sortMode}
                sortDir={sortDir}
                onSortModeChange={handleSortModeChange}
                onSortDirChange={handleSortDirChange}
              />
              <FileTree
                ref={treeRef}
                rootFolderId={focusedFolderId}
                sortMode={sortMode}
                sortDir={sortDir}
                onEnterFolder={setFocusedFolderId}
              />
            </div>

            {/* Create actions + Chat / Settings */}
            <div className="flex items-center justify-between px-3 py-1.5">
              <div className="flex items-center gap-1">
                <IconTooltipButton label="New page" onClick={() => createDocumentInContext()}>
                  <Plus size={14} />
                </IconTooltipButton>
                <IconTooltipButton label="New moodboard" onClick={() => createDocumentInContext("moodboard")}>
                  <LayoutGrid size={14} />
                </IconTooltipButton>
                <IconTooltipButton label="New folder" onClick={startCreateFolder}>
                  <FolderIcon size={14} />
                </IconTooltipButton>
                <IconTooltipButton label="Import" onClick={() => setIsImportOpen(true)}>
                  <Upload size={14} />
                </IconTooltipButton>
                <IconTooltipButton label="Graph" onClick={toggleGraph} active={isGraphOpen}>
                  <Waypoints size={14} />
                </IconTooltipButton>
              </div>
              <div className="flex items-center gap-1">
                <IconTooltipButton label="AI Chat" onClick={toggleChat} active={isChatOpen}>
                  <MessageSquare size={14} />
                </IconTooltipButton>
                <IconTooltipButton label="Settings" onClick={onOpenSettings}>
                  <Settings size={14} />
                </IconTooltipButton>
              </div>
            </div>
          </>
        )}
      </div>
      </div>

      <ImportDialog
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />
    </>
  );
}

function IconTooltipButton({
  label,
  onClick,
  active,
  framed,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  framed?: boolean;
  children: React.ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });

  const updateTooltipPos = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({
      top: rect.top - 6,
      left: rect.left + rect.width / 2,
    });
  }, []);

  const show = useCallback(() => {
    updateTooltipPos();
    setShowTooltip(true);
  }, [updateTooltipPos]);

  const hide = useCallback(() => setShowTooltip(false), []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={
          framed
            ? `relative flex-1 flex items-center justify-center py-1.5 rounded-md transition-colors ${
                active
                  ? "bg-ink/[0.12] text-foreground"
                  : "bg-ink/[0.06] text-muted-foreground hover:bg-ink/[0.1] hover:text-foreground"
              }`
            : `relative p-1 rounded transition-colors ${
                active
                  ? "bg-ink/5 text-foreground"
                  : "text-muted-foreground hover:bg-ink/5 hover:text-foreground"
              }`
        }
      >
        {children}
      </button>
      {showTooltip &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: "fixed",
              top: tooltipPos.top,
              left: tooltipPos.left,
              transform: "translate(-50%, -100%)",
            }}
            className="pointer-events-none z-[9999] px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-800 text-[10px] font-medium leading-none whitespace-nowrap border border-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:border-neutral-700"
          >
            {label}
          </span>,
          document.body
        )}
    </>
  );
}

function SidebarFolderBreadcrumb({
  path,
  onNavigate,
  sortMode,
  sortDir,
  onSortModeChange,
  onSortDirChange,
}: {
  path: { id: string; name: string }[];
  onNavigate: (folderId: string | null) => void;
  sortMode: SortMode;
  sortDir: SortDir;
  onSortModeChange: (mode: SortMode) => void;
  onSortDirChange: (dir: SortDir) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  const isAtRoot = path.length === 0;

  return (
    <div className="mx-2 mb-1.5 flex items-center gap-0.5 min-w-0">
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex items-center gap-1 whitespace-nowrap text-xs font-medium">
          <button
            type="button"
            onClick={() => onNavigate(null)}
            className={`shrink-0 transition-colors ${
              isAtRoot
                ? "text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground font-medium"
            }`}
          >
            root
          </button>
          {path.map((segment, index) => (
            <span key={segment.id} className="flex items-center gap-1">
              <span className="text-muted-foreground shrink-0">›</span>
              <button
                type="button"
                onClick={() => onNavigate(segment.id)}
                className={`shrink-0 max-w-[140px] truncate transition-colors ${
                  index === path.length - 1
                    ? "text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground font-medium"
                }`}
              >
                {segment.name}
              </button>
            </span>
          ))}
        </div>
      </div>
      <SidebarSortMenu
        sortMode={sortMode}
        sortDir={sortDir}
        onSortModeChange={onSortModeChange}
        onSortDirChange={onSortDirChange}
      />
    </div>
  );
}

function SidebarSortMenu({
  sortMode,
  sortDir,
  onSortModeChange,
  onSortDirChange,
}: {
  sortMode: SortMode;
  sortDir: SortDir;
  onSortModeChange: (mode: SortMode) => void;
  onSortDirChange: (dir: SortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Sort files"
        aria-expanded={open}
        title="Sort"
        onClick={() => setOpen((v) => !v)}
        className={`p-0.5 rounded shrink-0 transition-colors ${
          open
            ? "bg-ink/10 text-foreground"
            : "text-muted-foreground hover:bg-ink/5 hover:text-foreground"
        }`}
      >
        <ListFilter size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[9999] flex items-center gap-1.5 bg-surface border border-border rounded-lg shadow-lg px-1.5 py-1.5"
            style={{ top: menuPos.top, left: menuPos.left, transform: "translateX(-100%)" }}
          >
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              <button
                type="button"
                title="Ascending"
                aria-label="Sort ascending"
                aria-pressed={sortDir === "asc"}
                onClick={() => onSortDirChange("asc")}
                className={`p-1 transition-colors ${
                  sortDir === "asc"
                    ? "bg-ink/10 text-foreground"
                    : "text-muted-foreground hover:bg-ink/5 hover:text-foreground"
                }`}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                title="Descending"
                aria-label="Sort descending"
                aria-pressed={sortDir === "desc"}
                onClick={() => onSortDirChange("desc")}
                className={`p-1 transition-colors ${
                  sortDir === "desc"
                    ? "bg-ink/10 text-foreground"
                    : "text-muted-foreground hover:bg-ink/5 hover:text-foreground"
                }`}
              >
                <ArrowDown size={12} />
              </button>
            </div>
            <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground whitespace-nowrap">
              Sort by
              <select
                aria-label="Sort by"
                value={sortMode}
                onChange={(e) => onSortModeChange(e.target.value as SortMode)}
                className="text-xs font-medium bg-background border border-border rounded-md px-1.5 py-1 outline-none focus:border-ink/30 text-foreground"
              >
                {SORT_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
          </div>,
          document.body
        )}
    </>
  );
}
