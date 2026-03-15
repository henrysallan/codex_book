"use client";

import { useState, useCallback, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { Plus, Zap, FileText } from "lucide-react";

export function QuickNoteWidget() {
  const quickNotes = useAppStore((s) => s.quickNotes);
  const addQuickNote = useAppStore((s) => s.addQuickNote);
  const openDocument = useAppStore((s) => s.openDocument);
  const quickNoteParentId = useAppStore((s) => s.quickNoteParentId);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!input.trim()) return;
      await addQuickNote(input.trim());
      setInput("");
      inputRef.current?.focus();
    },
    [input, addQuickNote]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <h3 className="text-xs font-semibold text-foreground tracking-tight">
          Quick Notes
        </h3>
        {quickNoteParentId && (
          <button
            onClick={() => openDocument(quickNoteParentId)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="px-2 pb-2">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jot something down…"
            className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-border bg-white focus:outline-none focus:ring-1 focus:ring-black/10 placeholder:text-muted-foreground/60"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="shrink-0 p-1.5 rounded-lg border border-border hover:bg-black/5 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <Plus size={14} />
          </button>
        </form>
      </div>

      {/* Quick notes list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {quickNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Zap size={20} strokeWidth={1.5} className="mb-1 opacity-40" />
            <p className="text-xs opacity-60">No notes yet today</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {quickNotes.map((note) => (
              <li key={note.docId} className="group flex items-start gap-2 py-1">
                <FileText
                  size={13}
                  strokeWidth={1.5}
                  className="shrink-0 mt-0.5 text-muted-foreground"
                />
                <button
                  onClick={() => openDocument(note.docId)}
                  className="text-xs text-foreground leading-snug break-words min-w-0 text-left hover:underline"
                >
                  {note.title || "Untitled"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
