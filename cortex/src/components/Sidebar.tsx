"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { Folder, DocumentMeta } from "@/lib/types";
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
} from "lucide-react";

export function Sidebar({ onOpenImport }: { onOpenImport?: () => void }) {
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
  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const { user, signOut } = useAuth();

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [draggingDoc, setDraggingDoc] = useState<DocumentMeta | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    type: "doc" | "folder";
    id: string;
    name: string;
  } | null>(null);

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
    setDraggingDoc(doc ?? null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setDraggingDoc(null);
    const { active, over } = event;
    if (!over) return;

    const docId = active.id as string;
    const targetFolderId = over.id as string;

    // "root" is a special droppable — means move out of any folder
    const newFolderId = targetFolderId === "root" ? null : targetFolderId;

    // Don't move if already in that folder
    const currentFolderId = (active.data.current?.doc as DocumentMeta)?.folderId ?? null;
    if (currentFolderId === newFolderId) return;

    await moveDocument(docId, newFolderId);
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
          <span className="text-xs font-medium tracking-wide text-foreground">
            Cortex
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => createDocument(null)}
              className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
              title="New document"
            >
              <Plus size={14} />
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
              />
            ))}

            {/* Root-level documents */}
            {rootDocuments.map((doc) => (
              <DraggableDocItem
                key={doc.id}
                doc={doc}
                depth={0}
                isActive={activeDocumentId === doc.id}
                onOpen={openDocument}
                onDelete={requestDeleteDoc}
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
          <button className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-black/5 hover:text-foreground transition-colors">
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
        {draggingDoc ? (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white shadow-md border border-border text-xs text-foreground opacity-90">
            <FileText size={13} className="text-muted-foreground shrink-0" />
            <span className="truncate">{draggingDoc.title}</span>
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
}: {
  folder: Folder;
  depth: number;
  activeDocumentId: string | null;
  onToggle: (id: string) => void;
  onOpenDoc: (id: string) => void;
  onCreateDoc: (folderId: string) => Promise<string>;
  onDeleteDoc: (id: string) => void;
  onDeleteFolder: (id: string) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const { isOver, setNodeRef } = useDroppable({ id: folder.id });

  return (
    <div ref={setNodeRef}>
      <div
        className={`group flex items-center gap-1 px-2 py-1 rounded cursor-pointer transition-colors ${
          isOver
            ? "bg-accent/40 ring-1 ring-accent"
            : "hover:bg-black/5"
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onToggle(folder.id)}
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
        <span className="text-xs text-foreground truncate flex-1">
          {folder.name}
        </span>
        {hovering && (
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Draggable Document Tree Item ---------- */

function DraggableDocItem({
  doc,
  depth,
  isActive,
  onOpen,
  onDelete,
}: {
  doc: DocumentMeta;
  depth: number;
  isActive: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: doc.id,
    data: { doc },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors ${
        isDragging
          ? "opacity-40"
          : isActive
          ? "bg-black/5"
          : "hover:bg-black/[0.03]"
      }`}
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
      onClick={() => onOpen(doc.id)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <FileText size={13} className="text-muted-foreground shrink-0" />
      <span className="text-xs text-foreground truncate flex-1">
        {doc.title}
      </span>
      {hovering && !isDragging && (
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
  );
}
