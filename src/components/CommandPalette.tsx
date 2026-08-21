"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { FileText, FolderIcon, Search } from "lucide-react";
import { Modal } from "@/components/Modal";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  if (!isOpen) return null;
  return <CommandPaletteDialog onClose={onClose} />;
}

function CommandPaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const _dbFolders = useAppStore((s) => s._dbFolders);
  const openDocument = useAppStore((s) => s.openDocument);

  const items = useMemo(() => {
    return _dbDocuments.map((d) => ({
      id: d.id,
      type: "document" as const,
      title: d.title,
      subtitle: d.subtitle,
      folderId: d.folder_id,
    }));
  }, [_dbDocuments]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items
      .map((item) => {
        const title = item.title.toLowerCase();
        let score = 0;
        let j = 0;
        for (let i = 0; i < q.length && j < title.length; j++) {
          if (title[j] === q[i]) {
            score += j === 0 || title[j - 1] === " " ? 10 : 1;
            i++;
          }
        }
        const matched = j <= title.length;
        const allMatched =
          q.split("").every((c) => title.includes(c)) && matched;
        const substringIdx = title.indexOf(q);
        if (substringIdx >= 0) {
          score += 100 - substringIdx;
        }
        return { ...item, score: allMatched || substringIdx >= 0 ? score : -1 };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [items, query]);

  const safeIndex =
    filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);

  const getFolderName = useCallback(
    (folderId: string | null) => {
      if (!folderId) return null;
      const folder = _dbFolders.find((f) => f.id === folderId);
      return folder?.name || null;
    },
    [_dbFolders]
  );

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[safeIndex] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [safeIndex]);

  const handleSelect = useCallback(
    (item: (typeof items)[0]) => {
      if (item.type === "document") {
        openDocument(item.id);
      }
      onClose();
    },
    [openDocument, onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[safeIndex]) {
          handleSelect(filtered[safeIndex]);
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [filtered, safeIndex, handleSelect, onClose]
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Search documents"
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/20"
      panelClassName="relative w-[520px] bg-white rounded-xl shadow-2xl border border-border overflow-hidden"
    >
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search documents by name..."
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted"
          />
          <kbd className="text-[10px] text-muted-foreground bg-neutral-100 px-1.5 py-0.5 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {query ? "No documents found" : "No documents yet"}
            </div>
          )}
          {filtered.map((item, i) => {
            const folderName = getFolderName(item.folderId);
            return (
              <div
                key={item.id}
                className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
                  i === safeIndex ? "bg-neutral-100" : "hover:bg-neutral-50"
                }`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <FileText size={15} className="text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">
                    {item.title}
                  </div>
                  {folderName && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <FolderIcon size={10} />
                      {folderName}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
    </Modal>
  );
}
