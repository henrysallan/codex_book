"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
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
} from "@dnd-kit/core";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FolderIcon,
  FolderOpen,
  Plus,
  Settings,
  MessageSquare,
  Trash2,
  LogOut,
  Upload,
  AlertTriangle,
  Pencil,
  CheckSquare,
  CalendarDays,
  Zap,
  LayoutGrid,
} from "lucide-react";
import { DriveFolder } from "@/components/DriveFolder";

export function Sidebar({ onOpenImport, onOpenSettings }: { onOpenImport?: () => void; onOpenSettings?: () => void }) {
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
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const renameFolder = useAppStore((s) => s.renameFolder);
  const moveFolderAction = useAppStore((s) => s.moveFolder);
  const saveDocument = useAppStore((s) => s.saveDocument);
  const { user, signOut } = useAuth();

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [draggingDoc, setDraggingDoc] = useState<DocumentMeta | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<Folder | null>(null);
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

    // Pinned system docs
    rootDocuments
      .filter((d) => d.docType === "todo" || d.docType === "daily_parent" || d.docType === "quick_note_parent")
      .forEach(walkDoc);

    // Folders
    folders.forEach(walkFolder);

    // Root docs (non-pinned)
    rootDocuments
      .filter((d) => d.docType !== "todo" && d.docType !== "daily_parent" && d.docType !== "quick_note_parent")
      .forEach(walkDoc);

    return items;
  }, [folders, rootDocuments, expandedDocIds]);

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
    if (pendingDelete.type === "doc") {
      await deleteDocument(pendingDelete.id);
    } else {
      await deleteFolder(pendingDelete.id);
    }
    setPendingDelete(null);
  };

  // Require 5px movement before starting a drag — so clicks still work
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim());
      setNewFolderName("");
      setIsCreatingFolder(false);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
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
    setDraggingDoc(null);
    setDraggingFolder(null);
    const { active, over } = event;
    if (!over) return;

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
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="w-[260px] shrink-0 h-full flex flex-col bg-sidebar-bg">
        {/* Logo */}
        <div className="px-4 py-3 flex items-center justify-between">
          <img src="/book.svg" alt="Cortex" className="h-5 w-5 opacity-100" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => createDocument(null)}
              className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
              title="New document"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => createDocument(null, "moodboard")}
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
          </div>
        </div>

        {/* File Tree */}
        <RootDropZone>
          <div className="flex-1 overflow-y-auto px-1 py-1">
            {/* Pinned system documents (Todo, Daily Documents, Quick Notes) */}
            {rootDocuments
              .filter((d) => d.docType === "todo" || d.docType === "daily_parent" || d.docType === "quick_note_parent")
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
              />
            ))}

            {/* Google Drive synced folder */}
            <DriveFolder />

            {/* Divider between pinned items and the rest */}
            {(rootDocuments.some((d) => d.docType === "todo" || d.docType === "daily_parent" || d.docType === "quick_note_parent")) && (
              <div className="mx-2 my-1.5 border-t border-border/60" />
            )}

            {/* New folder input */}
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

            {/* Folders */}
            {folders.map((folder) => (
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
              />
            ))}

            {/* Root-level documents (excluding pinned system docs) */}
            {rootDocuments
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
              />
            ))}
          </div>
        </RootDropZone>

        {/* Bottom actions */}
        <div className="border-t border-border px-3 py-2 flex flex-col gap-1">
          <button
            onClick={toggleChat}
            className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
              isChatOpen
                ? "bg-black/5 text-foreground"
                : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
            }`}
          >
            <MessageSquare size={14} />
            AI Chat
          </button>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
          >
            <Settings size={14} />
            Settings
          </button>
          {onOpenImport && (
            <button
              onClick={onOpenImport}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
            >
              <Upload size={14} />
              Import from Notion
            </button>
          )}
          {user && (
            <button
              onClick={signOut}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors"
            >
              <LogOut size={14} />
              {user.user_metadata?.full_name || user.email || "Sign out"}
            </button>
          )}
        </div>
      </div>

      {/* Drag overlay — floating ghost while dragging */}
      <DragOverlay>
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
    </DndContext>
  );
}

/* ---------- Root Drop Zone (moving docs out of folders) ---------- */

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
}: {
  folder: Folder;
  depth: number;
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
          if (!consumed) onToggle(folder.id);
        }}
        onContextMenu={(e) => onContextMenu(e, folder.id, folder.name)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <span className="text-muted-foreground shrink-0">
          {folder.isExpanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </span>
        <span className="text-muted-foreground shrink-0">
          {folder.isExpanded ? (
            <FolderOpen size={13} />
          ) : (
            <FolderIcon size={13} />
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

      {folder.isExpanded && (
        <div>
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
            />
          ))}
        </div>
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
        <div>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
