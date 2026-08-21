"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/lib/store";
import { Folder, DocumentMeta, DocType } from "@/lib/types";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DropAnimation,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  FileText,
  FolderIcon,
  FolderOpen,
  Plus,
  Settings,
  MessageSquare,
  MessageSquarePlus,
  Trash2,
  AlertTriangle,
  Pencil,
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
import { AnimatedTreeList } from "@/components/AnimatedTreeList";

const DROP_FADE_MS = 180;

const fadeInPlaceDropAnimation: DropAnimation = {
  duration: DROP_FADE_MS,
  easing: "ease",
  keyframes: ({ transform }) => [
    { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
    { opacity: 0, transform: CSS.Transform.toString(transform.initial) },
  ],
  sideEffects: null,
};

const PINNED_DOC_ORDER: DocType[] = ["daily_parent", "todo", "quick_note_parent"];

const SORT_MODES = [
  { value: "manual", label: "Manual" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Modified" },
  { value: "kind", label: "Kind" },
] as const;

type SidebarSortMode = (typeof SORT_MODES)[number]["value"];
type SidebarSortDir = "asc" | "desc";
type FolderDateLookup = Map<string, { created: string; updated: string }>;

const DOC_KIND_ORDER: Record<DocType, number> = {
  note: 0,
  moodboard: 1,
  daily: 2,
  daily_parent: 3,
  todo: 4,
  quick_note_parent: 5,
};

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function compareFolder(
  a: Folder,
  b: Folder,
  mode: SidebarSortMode,
  dir: SidebarSortDir,
  dates: FolderDateLookup
) {
  const mul = dir === "asc" ? 1 : -1;
  let primary = 0;
  if (mode === "manual") {
    primary = a.position - b.position;
  } else if (mode === "created") {
    primary = (dates.get(a.id)?.created ?? "").localeCompare(dates.get(b.id)?.created ?? "");
  } else if (mode === "updated") {
    primary = (dates.get(a.id)?.updated ?? "").localeCompare(dates.get(b.id)?.updated ?? "");
  } else {
    primary = compareNames(a.name, b.name);
  }
  if (primary !== 0) return mul * primary;
  return mul * compareNames(a.name, b.name);
}

function compareDoc(a: DocumentMeta, b: DocumentMeta, mode: SidebarSortMode, dir: SidebarSortDir) {
  const mul = dir === "asc" ? 1 : -1;
  let primary = 0;
  if (mode === "manual") {
    primary = a.position - b.position;
  } else if (mode === "created") {
    primary = a.createdAt.localeCompare(b.createdAt);
  } else if (mode === "updated") {
    primary = a.updatedAt.localeCompare(b.updatedAt);
  } else if (mode === "kind") {
    primary = (DOC_KIND_ORDER[a.docType] ?? 99) - (DOC_KIND_ORDER[b.docType] ?? 99);
  } else {
    primary = compareNames(a.title || "Untitled", b.title || "Untitled");
  }
  if (primary !== 0) return mul * primary;
  return mul * compareNames(a.title || "Untitled", b.title || "Untitled");
}

function sortFolderList(
  folders: Folder[],
  mode: SidebarSortMode,
  dir: SidebarSortDir,
  dates: FolderDateLookup
): Folder[] {
  return [...folders]
    .sort((a, b) => compareFolder(a, b, mode, dir, dates))
    .map((f) => ({
      ...f,
      children: sortFolderList(f.children, mode, dir, dates),
      documents: sortDocList(f.documents, mode, dir, dates),
    }));
}

function sortDocList(
  docs: DocumentMeta[],
  mode: SidebarSortMode,
  dir: SidebarSortDir,
  dates: FolderDateLookup
): DocumentMeta[] {
  return [...docs]
    .sort((a, b) => compareDoc(a, b, mode, dir))
    .map((d) => ({
      ...d,
      childFolders: d.childFolders
        ? sortFolderList(d.childFolders, mode, dir, dates)
        : undefined,
      childDocuments: d.childDocuments
        ? sortDocList(d.childDocuments, mode, dir, dates)
        : undefined,
    }));
}

function pinnedDocIcon(docType: DocType) {
  if (docType === "todo") return <CheckSquare size={14} />;
  if (docType === "daily_parent") return <CalendarDays size={14} />;
  if (docType === "quick_note_parent") return <Zap size={14} />;
  return <FileText size={14} />;
}

export function Sidebar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const folders = useAppStore((s) => s.folders);
  const rootDocuments = useAppStore((s) => s.rootDocuments);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const openDocument = useAppStore((s) => s.openDocument);
  const createFolder = useAppStore((s) => s.createFolder);
  const createDocument = useAppStore((s) => s.createDocument);
  const deleteDocument = useAppStore((s) => s.deleteDocument);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const moveDocument = useAppStore((s) => s.moveDocument);
  const setParentDocument = useAppStore((s) => s.setParentDocument);
  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const _dbFolders = useAppStore((s) => s._dbFolders);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const toggleGraph = useAppStore((s) => s.toggleGraph);
  const isGraphOpen = useAppStore((s) => s.isGraphOpen);
  const addContextItem = useAppStore((s) => s.addContextItem);
  const renameFolder = useAppStore((s) => s.renameFolder);
  const moveFolderAction = useAppStore((s) => s.moveFolder);
  const saveDocument = useAppStore((s) => s.saveDocument);
  const runUndoable = useAppStore((s) => s.runUndoable);
  const { visible: driveVisible, openDrive } = useDriveShortcut();

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [draggingDoc, setDraggingDoc] = useState<DocumentMeta | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<Folder | null>(null);
  const clearDragGhostTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<{
    type: "doc" | "folder";
    id: string;
    name: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "doc" | "folder";
    id: string;
    name: string;
  } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{
    type: "doc" | "folder";
    id: string;
    name: string;
  } | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SidebarSortMode>("manual");
  const [sortDir, setSortDir] = useState<SidebarSortDir>("asc");

  useEffect(() => {
    try {
      setIsCollapsed(localStorage.getItem("cortex:sidebarCollapsed") === "true");
      const mode = localStorage.getItem("cortex:sidebarSortMode");
      const dir = localStorage.getItem("cortex:sidebarSortDir");
      if (mode === "manual" || mode === "name" || mode === "created" || mode === "updated" || mode === "kind") {
        setSortMode(mode);
      }
      if (dir === "asc" || dir === "desc") setSortDir(dir);
    } catch {
      // localStorage unavailable
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearDragGhostTimeout.current) clearTimeout(clearDragGhostTimeout.current);
    };
  }, []);

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("cortex:sidebarCollapsed", String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  const expandSidebar = useCallback(() => {
    setIsCollapsed(false);
    try {
      localStorage.setItem("cortex:sidebarCollapsed", "false");
    } catch {
      // localStorage unavailable
    }
  }, []);

  const startCreateFolder = useCallback(() => {
    expandSidebar();
    setIsCreatingFolder(true);
  }, [expandSidebar]);

  const enterFolder = useCallback((folderId: string) => {
    setFocusedFolderId(folderId);
  }, []);

  const focusedFolder = useMemo(() => {
    if (!focusedFolderId) return null;

    const findInFolderList = (list: Folder[]): Folder | null => {
      for (const f of list) {
        if (f.id === focusedFolderId) return f;
        const child = findInFolderList(f.children);
        if (child) return child;
      }
      return null;
    };

    const inTree = findInFolderList(folders);
    if (inTree) return inTree;

    const findInDocs = (docs: DocumentMeta[]): Folder | null => {
      for (const doc of docs) {
        if (doc.childFolders) {
          for (const childFolder of doc.childFolders) {
            if (childFolder.id === focusedFolderId) return childFolder;
            const nested = findInFolderList([childFolder]);
            if (nested) return nested;
          }
        }
        if (doc.childDocuments) {
          const found = findInDocs(doc.childDocuments);
          if (found) return found;
        }
      }
      return null;
    };

    return findInDocs(rootDocuments) ?? null;
  }, [focusedFolderId, folders, rootDocuments]);

  const folderDates = useMemo(() => {
    const map: FolderDateLookup = new Map();
    for (const f of _dbFolders) {
      map.set(f.id, { created: f.created_at, updated: f.updated_at });
    }
    return map;
  }, [_dbFolders]);

  const sortedFolders = useMemo(
    () => sortFolderList(folders, sortMode, sortDir, folderDates),
    [folders, sortMode, sortDir, folderDates]
  );

  const sortedRootDocuments = useMemo(
    () => sortDocList(rootDocuments, sortMode, sortDir, folderDates),
    [rootDocuments, sortMode, sortDir, folderDates]
  );

  const sortedFocusedFolder = useMemo(() => {
    if (!focusedFolder) return null;
    return {
      ...focusedFolder,
      children: sortFolderList(focusedFolder.children, sortMode, sortDir, folderDates),
      documents: sortDocList(focusedFolder.documents, sortMode, sortDir, folderDates),
    };
  }, [focusedFolder, sortMode, sortDir, folderDates]);

  const handleSortModeChange = useCallback((mode: SidebarSortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem("cortex:sidebarSortMode", mode);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const handleSortDirChange = useCallback((dir: SidebarSortDir) => {
    setSortDir(dir);
    try {
      localStorage.setItem("cortex:sidebarSortDir", dir);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const focusedFolderPath = useMemo(() => {
    if (!focusedFolderId) return [];
    const path: { id: string; name: string }[] = [];
    const folderMap = new Map(_dbFolders.map((f) => [f.id, f]));
    let currentId: string | null = focusedFolderId;
    while (currentId) {
      const folder = folderMap.get(currentId);
      if (!folder) break;
      path.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parent_id;
    }
    return path;
  }, [focusedFolderId, _dbFolders]);

  const pinnedDocs = useMemo(
    () =>
      PINNED_DOC_ORDER.map((type) =>
        rootDocuments.find((d) => d.docType === type)
      ).filter((d): d is DocumentMeta => d != null),
    [rootDocuments]
  );

  useEffect(() => {
    if (!focusedFolderId) return;
    if (!_dbFolders.some((f) => f.id === focusedFolderId)) {
      setFocusedFolderId(null);
    }
  }, [focusedFolderId, _dbFolders]);

  const createDocumentInContext = useCallback(
    (docType: DocType = "note") => {
      if (focusedFolderId) return createDocument(focusedFolderId, docType);
      return createDocument(null, docType);
    },
    [focusedFolderId, createDocument]
  );

  const didAutoCollapseForChat = useRef(false);
  useEffect(() => {
    if (!isChatOpen || didAutoCollapseForChat.current) return;
    didAutoCollapseForChat.current = true;
    setIsCollapsed(true);
    try {
      localStorage.setItem("cortex:sidebarCollapsed", "true");
    } catch {
      // localStorage unavailable
    }
  }, [isChatOpen]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Escape clears multi-selection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds]);

  // Flat ordered list of all visible items (for shift-click range selection)
  const flatVisibleItems = useMemo(() => {
    const items: string[] = [];

    const walkDoc = (doc: DocumentMeta) => {
      items.push(`doc:${doc.id}`);
      if (expandedDocIds.has(doc.id)) {
        doc.childFolders?.forEach(walkFolder);
        doc.childDocuments?.forEach(walkDoc);
      }
    };

    const walkFolder = (folder: Folder) => {
      items.push(`folder:${folder.id}`);
      if (folder.isExpanded) {
        folder.children.forEach(walkFolder);
        folder.documents.forEach(walkDoc);
      }
    };

    // Folders + root docs (or focused folder contents)
    if (focusedFolderId && sortedFocusedFolder) {
      sortedFocusedFolder.children.forEach((f) => items.push(`folder:${f.id}`));
      sortedFocusedFolder.documents.forEach(walkDoc);
    } else {
      sortedFolders.forEach(walkFolder);

      sortedRootDocuments
        .filter((d) => d.docType !== "todo" && d.docType !== "daily_parent" && d.docType !== "quick_note_parent")
        .forEach(walkDoc);
    }

    return items;
  }, [sortedFolders, sortedRootDocuments, expandedDocIds, focusedFolderId, sortedFocusedFolder]);

  /**
   * Unified click handler for sidebar items.
   * Returns true if the click was consumed by selection logic (Cmd/Shift),
   * meaning the caller should NOT perform its default action (open doc / toggle folder).
   */
  const handleItemClick = useCallback(
    (type: "doc" | "folder", id: string, e: React.MouseEvent): boolean => {
      const key = `${type}:${id}`;

      if (e.metaKey || e.ctrlKey) {
        // Cmd+click: toggle individual item in/out of selection
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setLastClickedId(key);
        return true;
      }

      if (e.shiftKey && lastClickedId) {
        // Shift+click: select range from anchor to clicked item
        const startIdx = flatVisibleItems.indexOf(lastClickedId);
        const endIdx = flatVisibleItems.indexOf(key);
        if (startIdx >= 0 && endIdx >= 0) {
          const lo = Math.min(startIdx, endIdx);
          const hi = Math.max(startIdx, endIdx);
          setSelectedIds(new Set(flatVisibleItems.slice(lo, hi + 1)));
        }
        return true;
      }

      // Normal click: clear selection, set anchor
      setSelectedIds(new Set());
      setLastClickedId(key);
      return false; // let caller do its default action
    },
    [lastClickedId, flatVisibleItems]
  );

  const requestDeleteDoc = (id: string) => {
    const doc = [...rootDocuments, ..._dbDocuments].find((d) => d.id === id);
    setPendingDelete({ type: "doc", id, name: doc?.title || "Untitled" });
  };

  const requestDeleteFolder = (id: string) => {
    const folder = folders.find((f) => f.id === id);
    setPendingDelete({ type: "folder", id, name: folder?.name || "Untitled" });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { type, id } = pendingDelete;
    setPendingDelete(null);
    if (type === "doc") {
      await deleteDocument(id);
    } else {
      await deleteFolder(id);
    }
  };

  // Require 5px movement before starting a drag — so clicks still work
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim(), focusedFolderId ?? null);
      setNewFolderName("");
      setIsCreatingFolder(false);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    if (clearDragGhostTimeout.current) {
      clearTimeout(clearDragGhostTimeout.current);
      clearDragGhostTimeout.current = null;
    }
    const doc = event.active.data.current?.doc as DocumentMeta | undefined;
    const folder = event.active.data.current?.folder as Folder | undefined;
    setDraggingDoc(doc ?? null);
    setDraggingFolder(folder ?? null);

    // If dragged item is not in selection, clear selection and select just it
    const key = folder
      ? `folder:${folder.id}`
      : doc
      ? `doc:${doc.id}`
      : null;
    if (key && !selectedIds.has(key)) {
      setSelectedIds(new Set([key]));
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    if (clearDragGhostTimeout.current) clearTimeout(clearDragGhostTimeout.current);
    clearDragGhostTimeout.current = setTimeout(() => {
      setDraggingDoc(null);
      setDraggingFolder(null);
      clearDragGhostTimeout.current = null;
    }, DROP_FADE_MS);

    const { active, over } = event;
    if (!over) return;

    await runUndoable(async () => {
    const targetId = over.id as string;
    const targetIsDoc = over.data.current?.isDocument === true;
    const targetIsRoot = targetId === "root";

    // Determine if this is a multi-item move
    const activeKey = active.data.current?.isFolder
      ? `folder:${(active.data.current.folder as Folder).id}`
      : `doc:${active.id}`;
    const isMulti = selectedIds.size > 1 && selectedIds.has(activeKey);

    if (isMulti) {
      // ── Multi-item move ──
      const docIds = [...selectedIds].filter((k) => k.startsWith("doc:")).map((k) => k.slice(4));
      const folderIds = [...selectedIds].filter((k) => k.startsWith("folder:")).map((k) => k.slice(7));

      if (targetIsRoot) {
        for (const fId of folderIds) await moveFolderAction(fId, null, null);
        for (const dId of docIds) {
          await setParentDocument(dId, null);
          await moveDocument(dId, null);
        }
      } else if (targetIsDoc) {
        const parentDocId = targetId.replace(/^doc-drop-/, "");
        for (const fId of folderIds) {
          if (fId === parentDocId) continue;
          await moveFolderAction(fId, null, parentDocId);
        }
        for (const dId of docIds) {
          if (dId === parentDocId) continue;
          await setParentDocument(dId, parentDocId);
        }
      } else {
        // Target is a folder
        const folderId = targetId.replace(/^folder-drop-/, "");
        for (const fId of folderIds) {
          if (fId === folderId) continue;
          await moveFolderAction(fId, folderId, null);
        }
        for (const dId of docIds) {
          await setParentDocument(dId, null);
          await moveDocument(dId, folderId);
        }
      }

      setSelectedIds(new Set());
      return;
    }

    // ── Single item drag (original logic) ──

    // ── Folder drag ──
    const isActiveFolder = active.data.current?.isFolder === true;
    if (isActiveFolder) {
      const draggedFolder = active.data.current?.folder as Folder;
      // Dropping on "root" — move to top level
      if (targetId === "root") {
        if (!draggedFolder.parentId && !draggedFolder.parentDocumentId) return; // already at root
        await moveFolderAction(draggedFolder.id, null, null);
        return;
      }

      // Dropping on a document — nest folder under that document
      if (targetIsDoc) {
        const parentDocId = targetId.replace(/^doc-drop-/, "");
        if (draggedFolder.parentDocumentId === parentDocId) return; // already there
        await moveFolderAction(draggedFolder.id, null, parentDocId);
        return;
      }

      // Dropping on a folder (folder-drop-{id} or raw folder id)
      const targetFolderId = targetId.replace(/^folder-drop-/, "");
      // Prevent dropping on itself or its current parent
      if (targetFolderId === draggedFolder.id) return;
      if (targetFolderId === draggedFolder.parentId) return;
      // Prevent dropping on a descendant (would create a cycle)
      const isDescendant = (folder: Folder, ancestorId: string): boolean => {
        for (const child of folder.children) {
          if (child.id === ancestorId) return true;
          if (isDescendant(child, ancestorId)) return true;
        }
        return false;
      };
      if (isDescendant(draggedFolder, targetFolderId)) return;
      await moveFolderAction(draggedFolder.id, targetFolderId, null);
      return;
    }

    // ── Document drag ──
    const docId = active.id as string;
    if (targetIsDoc) {
      const parentDocId = targetId.replace(/^doc-drop-/, "");
      if (docId === parentDocId) return;
      const draggedDoc = active.data.current?.doc as DocumentMeta | undefined;
      if (draggedDoc?.parentDocumentId === parentDocId) return;
      await setParentDocument(docId, parentDocId);
    } else {
      const targetFolderId = targetId.replace(/^folder-drop-/, "");
      const newFolderId = targetId === "root" ? null : targetFolderId;
      const currentFolderId = (active.data.current?.doc as DocumentMeta)?.folderId ?? null;
      const currentParentDocId = (active.data.current?.doc as DocumentMeta)?.parentDocumentId ?? null;

      if (currentParentDocId) {
        await setParentDocument(docId, null);
      }

      if (currentFolderId === newFolderId && !currentParentDocId) return;
      await moveDocument(docId, newFolderId);
    }

    setSelectedIds(new Set());
    });
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="shrink-0 h-full p-2">
      <div
        className={`h-full flex flex-col bg-sidebar-bg overflow-hidden rounded-md border border-border transition-[width] duration-200 ease-out ${
          isCollapsed ? "w-10" : "w-[260px]"
        }`}
      >
        {isCollapsed ? (
          <div className="flex flex-col h-full items-center py-3">
            <button
              onClick={toggleCollapsed}
              className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
              title="Expand sidebar"
            >
              <ChevronRight size={16} />
            </button>
            <div className="flex flex-col items-center gap-1 mt-2">
              <IconTooltipButton
                label="New document"
                onClick={() => createDocumentInContext()}
              >
                <Plus size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="New moodboard"
                onClick={() => createDocumentInContext("moodboard")}
              >
                <LayoutGrid size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="New folder"
                onClick={startCreateFolder}
              >
                <FolderIcon size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="Import"
                onClick={() => setIsImportOpen(true)}
              >
                <Upload size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="Graph"
                onClick={toggleGraph}
                active={isGraphOpen}
              >
                <Waypoints size={14} />
              </IconTooltipButton>
            </div>
            <div className="flex-1" />
            <div className="flex flex-col items-center gap-1">
              <IconTooltipButton
                label="AI Chat"
                onClick={toggleChat}
                active={isChatOpen}
              >
                <MessageSquare size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="Settings"
                onClick={onOpenSettings}
              >
                <Settings size={14} />
              </IconTooltipButton>
            </div>
          </div>
        ) : (
          <>
        {/* Logo */}
        <div className="px-2 pt-2 pb-1">
          <div className="flex items-center justify-between gap-2 rounded-md bg-black/[0.06] px-2.5 py-1.5">
            <span className="text-[15px] font-bold leading-none text-foreground">Book</span>
            <button
              onClick={toggleCollapsed}
              className="p-0.5 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
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

        {/* File Tree */}
        <RootDropZone>
          <div className="flex-1 overflow-y-auto px-1 py-1">
            <SidebarFolderBreadcrumb
              path={focusedFolderPath}
              onNavigate={setFocusedFolderId}
              sortMode={sortMode}
              sortDir={sortDir}
              onSortModeChange={handleSortModeChange}
              onSortDirChange={handleSortDirChange}
            />

            {focusedFolderId && sortedFocusedFolder ? (
              <AnimatedTreeList key={sortedFocusedFolder.id}>
                {sortedFocusedFolder.children.map((folder) => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    depth={0}
                    flatList
                    activeDocumentId={activeDocumentId}
                    onToggle={toggleFolder}
                    onOpenDoc={openDocument}
                    onCreateDoc={createDocument}
                    onDeleteDoc={requestDeleteDoc}
                    onDeleteFolder={requestDeleteFolder}
                    onContextMenu={(e, id, name) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "folder", id, name });
                    }}
                    onContextMenuDoc={(e, id, name) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id, name });
                    }}
                    renamingItem={renamingItem}
                    onRenameSubmit={async (type, id, newName) => {
                      if (type === "folder") await renameFolder(id, newName);
                      else await saveDocument(id, { title: newName });
                      setRenamingItem(null);
                    }}
                    onRenameCancel={() => setRenamingItem(null)}
                    expandedDocIds={expandedDocIds}
                    onToggleDoc={(id: string) => {
                      setExpandedDocIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      });
                    }}
                    selectedIds={selectedIds}
                    onItemClick={handleItemClick}
                    onEnterFolder={enterFolder}
                  />
                ))}
                {sortedFocusedFolder.documents.map((doc) => (
                  <DraggableDocItem
                    key={doc.id}
                    doc={doc}
                    depth={0}
                    isActive={activeDocumentId === doc.id}
                    onOpen={openDocument}
                    onDelete={requestDeleteDoc}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id: doc.id, name: doc.title || "Untitled" });
                    }}
                    renamingItem={renamingItem}
                    onRenameSubmit={async (newName) => {
                      await saveDocument(doc.id, { title: newName });
                      setRenamingItem(null);
                    }}
                    onRenameCancel={() => setRenamingItem(null)}
                    expandedDocIds={expandedDocIds}
                    onToggleDoc={(id) => {
                      setExpandedDocIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      });
                    }}
                    activeDocumentId={activeDocumentId}
                    onToggleFolder={toggleFolder}
                    onCreateDoc={createDocument}
                    onDeleteFolder={requestDeleteFolder}
                    onContextMenuFolder={(e, id, name) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "folder", id, name });
                    }}
                    onContextMenuDoc={(e, id, name) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id, name });
                    }}
                    onRenameSubmitFolder={async (type, id, newName) => {
                      if (type === "folder") await renameFolder(id, newName);
                      else await saveDocument(id, { title: newName });
                      setRenamingItem(null);
                    }}
                    selectedIds={selectedIds}
                    onItemClick={handleItemClick}
                    onEnterFolder={enterFolder}
                  />
                ))}
              </AnimatedTreeList>
            ) : (
              <AnimatedTreeList key="root">
            {/* Folders */}
            {sortedFolders.map((folder) => (
              <FolderItem
                key={folder.id}
                folder={folder}
                depth={0}
                activeDocumentId={activeDocumentId}
                onToggle={toggleFolder}
                onOpenDoc={openDocument}
                onCreateDoc={createDocument}
                onDeleteDoc={requestDeleteDoc}
                onDeleteFolder={requestDeleteFolder}
                onContextMenu={(e, id, name) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: "folder", id, name });
                }}
                onContextMenuDoc={(e, id, name) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id, name });
                }}
                renamingItem={renamingItem}
                onRenameSubmit={async (type, id, newName) => {
                  if (type === "folder") await renameFolder(id, newName);
                  else await saveDocument(id, { title: newName });
                  setRenamingItem(null);
                }}
                onRenameCancel={() => setRenamingItem(null)}
                expandedDocIds={expandedDocIds}
                onToggleDoc={(id: string) => {
                  setExpandedDocIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                selectedIds={selectedIds}
                onItemClick={handleItemClick}
                onEnterFolder={enterFolder}
              />
            ))}

            {/* Root-level documents (excluding pinned system docs) */}
            {sortedRootDocuments
              .filter((d) => d.docType !== "todo" && d.docType !== "daily_parent" && d.docType !== "quick_note_parent")
              .map((doc) => (
              <DraggableDocItem
                key={doc.id}
                doc={doc}
                depth={0}
                isActive={activeDocumentId === doc.id}
                onOpen={openDocument}
                onDelete={requestDeleteDoc}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id: doc.id, name: doc.title || "Untitled" });
                }}
                renamingItem={renamingItem}
                onRenameSubmit={async (newName) => {
                  await saveDocument(doc.id, { title: newName });
                  setRenamingItem(null);
                }}
                onRenameCancel={() => setRenamingItem(null)}
                expandedDocIds={expandedDocIds}
                onToggleDoc={(id) => {
                  setExpandedDocIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                activeDocumentId={activeDocumentId}
                onToggleFolder={toggleFolder}
                onCreateDoc={createDocument}
                onDeleteFolder={requestDeleteFolder}
                onContextMenuFolder={(e, id, name) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: "folder", id, name });
                }}
                onContextMenuDoc={(e, id, name) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: "doc", id, name });
                }}
                onRenameSubmitFolder={async (type, id, newName) => {
                  if (type === "folder") await renameFolder(id, newName);
                  else await saveDocument(id, { title: newName });
                  setRenamingItem(null);
                }}
                selectedIds={selectedIds}
                onItemClick={handleItemClick}
                onEnterFolder={enterFolder}
              />
            ))}
              </AnimatedTreeList>
            )}
          </div>

          {isCreatingFolder && (
            <div className="px-3 py-1">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") setIsCreatingFolder(false);
                }}
                onBlur={() => {
                  if (newFolderName.trim()) handleCreateFolder();
                  else setIsCreatingFolder(false);
                }}
                autoFocus
                placeholder="Folder name"
                className="w-full text-xs bg-white border border-border rounded px-2 py-1 outline-none focus:border-black/30"
              />
            </div>
          )}

          {/* Create actions + Chat / Settings */}
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-1">
              <button
                onClick={() => createDocumentInContext()}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
                title="New document"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={() => createDocumentInContext("moodboard")}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
                title="New moodboard"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                onClick={() => setIsCreatingFolder(true)}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
                title="New folder"
              >
                <FolderIcon size={14} />
              </button>
              <button
                onClick={() => setIsImportOpen(true)}
                className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
                title="Import"
              >
                <Upload size={14} />
              </button>
              <button
                onClick={toggleGraph}
                className={`p-1 rounded hover:bg-black/5 transition-colors ${
                  isGraphOpen
                    ? "bg-black/5 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Graph"
              >
                <Waypoints size={14} />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <IconTooltipButton
                label="AI Chat"
                onClick={toggleChat}
                active={isChatOpen}
              >
                <MessageSquare size={14} />
              </IconTooltipButton>
              <IconTooltipButton
                label="Settings"
                onClick={onOpenSettings}
              >
                <Settings size={14} />
              </IconTooltipButton>
            </div>
          </div>
        </RootDropZone>
          </>
        )}
      </div>
      </div>

      {/* Drag overlay — floating ghost while dragging */}
      <DragOverlay dropAnimation={fadeInPlaceDropAnimation}>
        {(draggingDoc || draggingFolder) ? (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white shadow-md border border-border text-xs text-foreground opacity-90">
            {draggingFolder ? (
              <FolderIcon size={13} className="text-muted-foreground shrink-0" />
            ) : (
              <FileText size={13} className="text-muted-foreground shrink-0" />
            )}
            <span className="truncate">
              {draggingFolder ? draggingFolder.name : draggingDoc?.title}
            </span>
            {selectedIds.size > 1 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-medium leading-none">
                {selectedIds.size}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>

      {/* Confirm delete modal */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-[360px] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-3 flex items-start gap-3">
              <div className="p-2 rounded-full bg-red-50 text-red-500 shrink-0 mt-0.5">
                <AlertTriangle size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Delete {pendingDelete.type === "doc" ? "document" : "folder"}?
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  <strong className="text-foreground">{pendingDelete.name}</strong>{" "}
                  will be permanently deleted.
                  {pendingDelete.type === "folder" && " Documents inside will be moved to root."}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-xs rounded-lg text-foreground hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-3 py-1.5 text-xs rounded-lg text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white rounded-lg border border-border shadow-lg py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-black/5 transition-colors"
            onClick={() => {
              if (contextMenu.type === "doc") {
                addContextItem({
                  type: "document",
                  docId: contextMenu.id,
                  title: contextMenu.name,
                });
              } else {
                addContextItem({
                  type: "folder",
                  folderId: contextMenu.id,
                  title: contextMenu.name,
                });
              }
              if (!isChatOpen) toggleChat();
              setContextMenu(null);
            }}
          >
            <MessageSquarePlus size={12} />
            Add to context
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-black/5 transition-colors"
            onClick={() => {
              setRenamingItem({ type: contextMenu.type, id: contextMenu.id, name: contextMenu.name });
              setContextMenu(null);
            }}
          >
            <Pencil size={12} />
            Rename
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
            onClick={() => {
              if (contextMenu.type === "doc") requestDeleteDoc(contextMenu.id);
              else requestDeleteFolder(contextMenu.id);
              setContextMenu(null);
            }}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      )}

      <ImportDialog
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />
    </DndContext>
  );
}

/* ---------- Root Drop Zone (moving docs out of folders) ---------- */

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
                  ? "bg-black/[0.12] text-foreground"
                  : "bg-black/[0.06] text-muted-foreground hover:bg-black/[0.1] hover:text-foreground"
              }`
            : `relative p-1 rounded transition-colors ${
                active
                  ? "bg-black/5 text-foreground"
                  : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
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
            className="pointer-events-none z-[9999] px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-800 text-[10px] font-medium leading-none whitespace-nowrap border border-neutral-200"
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
  sortMode: SidebarSortMode;
  sortDir: SidebarSortDir;
  onSortModeChange: (mode: SidebarSortMode) => void;
  onSortDirChange: (dir: SidebarSortDir) => void;
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
  sortMode: SidebarSortMode;
  sortDir: SidebarSortDir;
  onSortModeChange: (mode: SidebarSortMode) => void;
  onSortDirChange: (dir: SidebarSortDir) => void;
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
            ? "bg-black/10 text-foreground"
            : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
        }`}
      >
        <ListFilter size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[9999] flex items-center gap-1.5 bg-white border border-border rounded-lg shadow-lg px-1.5 py-1.5"
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
                    ? "bg-black/10 text-foreground"
                    : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
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
                    ? "bg-black/10 text-foreground"
                    : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
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
                onChange={(e) => onSortModeChange(e.target.value as SidebarSortMode)}
                className="text-xs font-medium bg-white border border-border rounded-md px-1.5 py-1 outline-none focus:border-black/30 text-foreground"
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

function RootDropZone({ children }: { children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: "root" });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-h-0 flex flex-col transition-colors ${
        isOver ? "bg-accent/30" : ""
      }`}
    >
      {children}
    </div>
  );
}

/* ---------- Folder Tree Item (Droppable) ---------- */

function FolderItem({
  folder,
  depth,
  flatList,
  activeDocumentId,
  onToggle,
  onOpenDoc,
  onCreateDoc,
  onDeleteDoc,
  onDeleteFolder,
  onContextMenu,
  onContextMenuDoc,
  renamingItem,
  onRenameSubmit,
  onRenameCancel,
  expandedDocIds,
  onToggleDoc,
  selectedIds,
  onItemClick,
  onEnterFolder,
}: {
  folder: Folder;
  depth: number;
  flatList?: boolean;
  activeDocumentId: string | null;
  onToggle: (id: string) => void;
  onOpenDoc: (id: string) => void;
  onCreateDoc: (folderId: string) => Promise<string>;
  onDeleteDoc: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, name: string) => void;
  onContextMenuDoc: (e: React.MouseEvent, id: string, name: string) => void;
  renamingItem: { type: "doc" | "folder"; id: string; name: string } | null;
  onRenameSubmit: (type: "doc" | "folder", id: string, newName: string) => void;
  onRenameCancel: () => void;
  expandedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  selectedIds: Set<string>;
  onItemClick: (type: "doc" | "folder", id: string, e: React.MouseEvent) => boolean;
  onEnterFolder?: (folderId: string) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `folder-drop-${folder.id}` });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `folder-drag-${folder.id}`,
    data: { folder, isFolder: true },
  });
  const isRenaming = renamingItem?.type === "folder" && renamingItem.id === folder.id;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(folder.name);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(renamingItem!.name);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [isRenaming, renamingItem]);

  const mergedRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef]
  );

  const isSelected = selectedIds.has(`folder:${folder.id}`);

  return (
    <div ref={mergedRef} {...(isRenaming ? {} : listeners)} {...(isRenaming ? {} : attributes)}>
      <div
        className={`group flex items-center gap-1 px-2 py-1 rounded cursor-pointer transition-colors ${
          isDragging
            ? "opacity-40"
            : isOver
            ? "bg-accent/40 ring-1 ring-accent"
            : isSelected
            ? "bg-blue-100/50"
            : "hover:bg-black/5"
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={(e) => {
          if (isRenaming) return;
          const consumed = onItemClick("folder", folder.id, e);
          if (!consumed && !flatList) onToggle(folder.id);
        }}
        onDoubleClick={(e) => {
          if (isRenaming || !onEnterFolder) return;
          e.stopPropagation();
          onEnterFolder(folder.id);
        }}
        onContextMenu={(e) => onContextMenu(e, folder.id, folder.name)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <span className="text-muted-foreground shrink-0">
          {flatList ? (
            <ChevronRight size={12} />
          ) : folder.isExpanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </span>
        <span className="text-muted-foreground shrink-0">
          {flatList || !folder.isExpanded ? (
            <FolderIcon size={13} />
          ) : (
            <FolderOpen size={13} />
          )}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = renameValue.trim();
                if (v) onRenameSubmit("folder", folder.id, v);
                else onRenameCancel();
              }
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={() => {
              const v = renameValue.trim();
              if (v && v !== folder.name) onRenameSubmit("folder", folder.id, v);
              else onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 text-xs bg-white border border-border rounded px-1 py-0 outline-none focus:border-black/30 min-w-0"
          />
        ) : (
          <span className="text-xs text-foreground truncate flex-1">
            {folder.name}
          </span>
        )}
        {hovering && !isRenaming && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCreateDoc(folder.id);
              }}
              className="p-0.5 rounded hover:bg-black/10 text-muted-foreground"
              title="New doc in folder"
            >
              <Plus size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(folder.id);
              }}
              className="p-0.5 rounded hover:bg-black/10 text-muted-foreground"
              title="Delete folder"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>

      {folder.isExpanded && !flatList && (
        <AnimatedTreeList>
          {folder.children.map((child) => (
            <FolderItem
              key={child.id}
              folder={child}
              depth={depth + 1}
              activeDocumentId={activeDocumentId}
              onToggle={onToggle}
              onOpenDoc={onOpenDoc}
              onCreateDoc={onCreateDoc}
              onDeleteDoc={onDeleteDoc}
              onDeleteFolder={onDeleteFolder}
              onContextMenu={onContextMenu}
              onContextMenuDoc={onContextMenuDoc}
              renamingItem={renamingItem}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              expandedDocIds={expandedDocIds}
              onToggleDoc={onToggleDoc}
              selectedIds={selectedIds}
              onItemClick={onItemClick}
              onEnterFolder={onEnterFolder}
            />
          ))}
          {folder.documents.map((doc) => (
            <DraggableDocItem
              key={doc.id}
              doc={doc}
              depth={depth + 1}
              isActive={activeDocumentId === doc.id}
              onOpen={onOpenDoc}
              onDelete={onDeleteDoc}
              onContextMenu={(e) => onContextMenuDoc(e, doc.id, doc.title || "Untitled")}
              renamingItem={renamingItem}
              onRenameSubmit={async (newName) => onRenameSubmit("doc", doc.id, newName)}
              onRenameCancel={onRenameCancel}
              expandedDocIds={expandedDocIds}
              onToggleDoc={onToggleDoc}
              activeDocumentId={activeDocumentId}
              onToggleFolder={onToggle}
              onCreateDoc={onCreateDoc}
              onDeleteFolder={onDeleteFolder}
              onContextMenuFolder={onContextMenu}
              onContextMenuDoc={onContextMenuDoc}
              onRenameSubmitFolder={onRenameSubmit}
              selectedIds={selectedIds}
              onItemClick={onItemClick}
              onEnterFolder={onEnterFolder}
            />
          ))}
        </AnimatedTreeList>
      )}
    </div>
  );
}

/* ---------- Draggable + Droppable Document Tree Item ---------- */

function DraggableDocItem({
  doc,
  depth,
  isActive,
  onOpen,
  onDelete,
  onContextMenu,
  renamingItem,
  onRenameSubmit,
  onRenameCancel,
  expandedDocIds,
  onToggleDoc,
  activeDocumentId,
  // Folder-rendering props (for child folders nested under this doc)
  onToggleFolder,
  onCreateDoc,
  onDeleteFolder,
  onContextMenuFolder,
  onContextMenuDoc,
  onRenameSubmitFolder,
  // Multi-select props
  selectedIds,
  onItemClick,
  onEnterFolder,
}: {
  doc: DocumentMeta;
  depth: number;
  isActive: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  renamingItem: { type: "doc" | "folder"; id: string; name: string } | null;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
  expandedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  activeDocumentId: string | null;
  // Folder-rendering props
  onToggleFolder?: (id: string) => void;
  onCreateDoc?: (folderId: string) => Promise<string>;
  onDeleteFolder?: (id: string) => void;
  onContextMenuFolder?: (e: React.MouseEvent, id: string, name: string) => void;
  onContextMenuDoc?: (e: React.MouseEvent, id: string, name: string) => void;
  onRenameSubmitFolder?: (type: "doc" | "folder", id: string, newName: string) => void;
  // Multi-select props
  selectedIds?: Set<string>;
  onItemClick?: (type: "doc" | "folder", id: string, e: React.MouseEvent) => boolean;
  onEnterFolder?: (folderId: string) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: doc.id,
    data: { doc },
  });
  const { isOver, setNodeRef: setDropRef } = useDroppable({
    id: `doc-drop-${doc.id}`,
    data: { isDocument: true },
  });
  const isRenaming = renamingItem?.type === "doc" && renamingItem.id === doc.id;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(doc.title || "Untitled");

  const hasChildren = (doc.childDocuments?.length ?? 0) > 0 || (doc.childFolders?.length ?? 0) > 0;
  const isExpanded = expandedDocIds.has(doc.id);
  const isSelected = selectedIds?.has(`doc:${doc.id}`) ?? false;

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(renamingItem!.name);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [isRenaming, renamingItem]);

  // Merge drag + drop refs
  const mergedRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef]
  );

  return (
    <div>
      <div
        ref={mergedRef}
        {...(isRenaming ? {} : listeners)}
        {...(isRenaming ? {} : attributes)}
        className={`group flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors ${
          isDragging
            ? "opacity-40"
            : isOver
            ? "bg-accent/40 ring-1 ring-accent"
            : isSelected
            ? "bg-blue-100/50"
            : isActive
            ? "bg-black/5"
            : "hover:bg-black/[0.03]"
        }`}
        style={{ paddingLeft: `${depth * 16 + (hasChildren ? 8 : 24)}px` }}
        onClick={(e) => {
          if (isRenaming) return;
          const consumed = onItemClick?.("doc", doc.id, e);
          if (!consumed) onOpen(doc.id);
        }}
        onContextMenu={onContextMenu}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {/* Expand/collapse chevron only for parent docs with children */}
        {hasChildren && (
          <span
            className="text-muted-foreground shrink-0 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onToggleDoc(doc.id);
            }}
          >
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}
        {doc.docType === "todo" ? (
          <CheckSquare size={13} className="text-muted-foreground shrink-0" />
        ) : doc.docType === "daily_parent" || doc.docType === "daily" ? (
          <CalendarDays size={13} className="text-muted-foreground shrink-0" />
        ) : doc.docType === "quick_note_parent" ? (
          <Zap size={13} className="text-muted-foreground shrink-0" />
        ) : doc.docType === "moodboard" ? (
          <LayoutGrid size={13} className="text-muted-foreground shrink-0" />
        ) : (
          <FileText size={13} className="text-muted-foreground shrink-0" />
        )}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = renameValue.trim();
                if (v) onRenameSubmit(v);
                else onRenameCancel();
              }
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={() => {
              const v = renameValue.trim();
              if (v && v !== (doc.title || "Untitled")) onRenameSubmit(v);
              else onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 text-xs bg-white border border-border rounded px-1 py-0 outline-none focus:border-black/30 min-w-0"
          />
        ) : (
          <span className="text-xs text-foreground truncate flex-1">
            {doc.title}
          </span>
        )}
        {hovering && !isDragging && !isRenaming && doc.docType !== "todo" && doc.docType !== "daily_parent" && doc.docType !== "quick_note_parent" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(doc.id);
            }}
            className="p-0.5 rounded hover:bg-black/10 text-muted-foreground"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Render child folders and documents when expanded */}
      {hasChildren && isExpanded && (
        <AnimatedTreeList>
          {/* Child folders nested under this document */}
          {doc.childFolders?.map((childFolder) => (
            <FolderItem
              key={childFolder.id}
              folder={childFolder}
              depth={depth + 1}
              activeDocumentId={activeDocumentId}
              onToggle={onToggleFolder ?? (() => {})}
              onOpenDoc={onOpen}
              onCreateDoc={onCreateDoc ?? (async () => "")}
              onDeleteDoc={onDelete}
              onDeleteFolder={onDeleteFolder ?? (() => {})}
              onContextMenu={onContextMenuFolder ?? (() => {})}
              onContextMenuDoc={onContextMenuDoc ?? (() => {})}
              renamingItem={renamingItem}
              onRenameSubmit={onRenameSubmitFolder ?? (() => {})}
              onRenameCancel={onRenameCancel}
              expandedDocIds={expandedDocIds}
              onToggleDoc={onToggleDoc}
              selectedIds={selectedIds ?? new Set()}
              onItemClick={onItemClick ?? (() => false)}
              onEnterFolder={onEnterFolder}
            />
          ))}
          {/* Child documents */}
          {doc.childDocuments!.map((child) => (
            <DraggableDocItem
              key={child.id}
              doc={child}
              depth={depth + 1}
              isActive={activeDocumentId === child.id}
              onOpen={onOpen}
              onDelete={onDelete}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e);
              }}
              renamingItem={renamingItem}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              expandedDocIds={expandedDocIds}
              onToggleDoc={onToggleDoc}
              activeDocumentId={activeDocumentId}
              onToggleFolder={onToggleFolder}
              onCreateDoc={onCreateDoc}
              onDeleteFolder={onDeleteFolder}
              onContextMenuFolder={onContextMenuFolder}
              onContextMenuDoc={onContextMenuDoc}
              onRenameSubmitFolder={onRenameSubmitFolder}
              selectedIds={selectedIds}
              onItemClick={onItemClick}
              onEnterFolder={onEnterFolder}
            />
          ))}
        </AnimatedTreeList>
      )}
    </div>
  );
}
