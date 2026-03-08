"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { Folder, DocumentMeta } from "@/lib/types";
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
} from "lucide-react";

export function Sidebar() {
  const folders = useAppStore((s) => s.folders);
  const rootDocuments = useAppStore((s) => s.rootDocuments);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const openDocument = useAppStore((s) => s.openDocument);
  const createFolder = useAppStore((s) => s.createFolder);
  const createDocument = useAppStore((s) => s.createDocument);
  const deleteDocument = useAppStore((s) => s.deleteDocument);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isChatOpen = useAppStore((s) => s.isChatOpen);
  const { user, signOut } = useAuth();

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim());
      setNewFolderName("");
      setIsCreatingFolder(false);
    }
  };

  return (
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
            onDeleteDoc={deleteDocument}
            onDeleteFolder={deleteFolder}
          />
        ))}

        {/* Root-level documents */}
        {rootDocuments.map((doc) => (
          <DocItem
            key={doc.id}
            doc={doc}
            depth={0}
            isActive={activeDocumentId === doc.id}
            onOpen={openDocument}
            onDelete={deleteDocument}
          />
        ))}
      </div>

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
  );
}

/* ---------- Folder Tree Item ---------- */

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

  return (
    <div>
      <div
        className="group flex items-center gap-1 px-2 py-1 rounded cursor-pointer hover:bg-black/5 transition-colors"
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
            <DocItem
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

/* ---------- Document Tree Item ---------- */

function DocItem({
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

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors ${
        isActive ? "bg-black/5" : "hover:bg-black/[0.03]"
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
      {hovering && (
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
