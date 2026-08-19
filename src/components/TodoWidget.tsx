"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { Plus, Check, Circle } from "lucide-react";

export function TodoWidget() {
  const todoItems = useAppStore((s) => s.todoItems);
  const addTodo = useAppStore((s) => s.addTodo);
  const toggleTodo = useAppStore((s) => s.toggleTodo);
  const openDocument = useAppStore((s) => s.openDocument);
  const todoDocId = useAppStore((s) => s.todoDocId);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Only show unchecked items on the dashboard
  const incomplete = todoItems.filter((t) => !t.checked);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!input.trim()) return;
      await addTodo(input.trim());
      setInput("");
      inputRef.current?.focus();
    },
    [input, addTodo]
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
          Todo
        </h3>
        {todoDocId && (
          <button
            onClick={() => openDocument(todoDocId)}
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
            placeholder="Add a todo…"
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

      {/* Todo list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {incomplete.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Check size={20} strokeWidth={1.5} className="mb-1 opacity-40" />
            <p className="text-xs opacity-60">All done!</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {incomplete.map((item) => (
              <li key={item.blockId} className="group flex items-start gap-2 py-1">
                <button
                  onClick={() => toggleTodo(item.blockId)}
                  className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-black/5 transition-colors"
                >
                  <Circle
                    size={14}
                    strokeWidth={1.5}
                    className="text-muted-foreground group-hover:text-foreground transition-colors"
                  />
                </button>
                <span className="text-xs text-foreground leading-snug break-words min-w-0">
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
