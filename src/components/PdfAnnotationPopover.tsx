"use client";

/**
 * Inline popover that appears when clicking an existing PDF annotation.
 * Shows the highlighted text, note editor, or chat thread depending on type.
 */

import { useState, useRef, useEffect } from "react";
import type { PdfAnnotation, PdfAnnotationColor, AnnotationMessage } from "@/lib/types";
import { HIGHLIGHT_COLORS } from "./PdfSelectionMenu";
import {
  X,
  Trash2,
  Highlighter,
  StickyNote,
  MessageSquare,
  Loader2,
  Send,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";

const COLOR_OPTIONS: PdfAnnotationColor[] = ["yellow", "green", "blue", "pink", "purple"];
const COLOR_CSS: Record<PdfAnnotationColor, string> = {
  yellow: "bg-yellow-300",
  green: "bg-green-300",
  blue: "bg-blue-300",
  pink: "bg-pink-300",
  purple: "bg-purple-300",
};

interface PdfAnnotationPopoverProps {
  annotation: PdfAnnotation;
  position: { x: number; y: number };
  onClose: () => void;
  onDelete: (id: string) => void;
  onUpdateColor: (id: string, color: PdfAnnotationColor) => void;
  onUpdateNote: (id: string, note: string) => void;
  onSendChatMessage: (id: string, content: string) => Promise<void>;
}

export function PdfAnnotationPopover({
  annotation,
  position,
  onClose,
  onDelete,
  onUpdateColor,
  onUpdateNote,
  onSendChatMessage,
}: PdfAnnotationPopoverProps) {
  const [noteText, setNoteText] = useState(annotation.note ?? "");
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [annotation.messages, streamingContent]);

  // Auto-save note with debounce
  function handleNoteChange(text: string) {
    setNoteText(text);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => {
      onUpdateNote(annotation.id, text);
    }, 500);
  }

  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text || isSending) return;
    setChatInput("");
    setIsSending(true);
    try {
      await onSendChatMessage(annotation.id, text);
    } finally {
      setIsSending(false);
    }
  }

  const typeIcon = {
    highlight: <Highlighter size={12} />,
    note: <StickyNote size={12} />,
    chat: <MessageSquare size={12} />,
  }[annotation.type];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60]" onClick={onClose} />

      <div
        className="fixed z-[61] bg-white rounded-xl shadow-lg border border-border flex flex-col"
        style={{
          left: position.x,
          top: position.y,
          transform: "translateY(4px)",
          width: annotation.type === "chat" ? 300 : 260,
          maxHeight: annotation.type === "chat" ? 400 : 300,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            {typeIcon}
            <span className="capitalize">{annotation.type}</span>
          </div>
          <div className="flex items-center gap-0.5">
            {/* Color picker */}
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => onUpdateColor(annotation.id, c)}
                className={`w-3 h-3 rounded-full ${COLOR_CSS[c]} transition-all ${
                  annotation.color === c ? "ring-1 ring-offset-1 ring-black/30 scale-110" : "opacity-60 hover:opacity-100"
                }`}
              />
            ))}
            <button
              onClick={() => onDelete(annotation.id)}
              className="p-0.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500 transition-colors ml-1"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
            <button
              onClick={onClose}
              className="p-0.5 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Highlighted text */}
        <div
          className="px-3 py-1.5 border-b border-border shrink-0"
          style={{ backgroundColor: HIGHLIGHT_COLORS[annotation.color] }}
        >
          <p className="text-[11px] text-foreground leading-relaxed line-clamp-3">
            &ldquo;{annotation.anchor.exact}&rdquo;
          </p>
        </div>

        {/* Note content */}
        {annotation.type === "note" && (
          <div className="p-2">
            <textarea
              value={noteText}
              onChange={(e) => handleNoteChange(e.target.value)}
              placeholder="Write a note…"
              rows={4}
              className="w-full text-xs bg-transparent border border-border rounded-lg p-2 outline-none resize-none placeholder:text-black/20"
              autoFocus
            />
          </div>
        )}

        {/* Chat content */}
        {annotation.type === "chat" && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
              {annotation.messages.length === 0 && !isSending && (
                <p className="text-[11px] text-muted-foreground text-center mt-2">
                  Ask a question about this text.
                </p>
              )}
              {annotation.messages.map((msg: AnnotationMessage, i: number) => (
                <div
                  key={i}
                  className={`text-xs ${
                    msg.role === "user" ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <div className="text-[9px] text-muted mb-0.5 uppercase tracking-wider">
                    {msg.role === "user" ? "You" : "Codex"}
                  </div>
                  {msg.role === "user" ? (
                    <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  ) : (
                    <Markdown content={msg.content} className="text-[11px]" />
                  )}
                </div>
              ))}

              {isSending && streamingContent && (
                <div className="text-xs text-muted-foreground">
                  <div className="text-[9px] text-muted mb-0.5 uppercase tracking-wider flex items-center gap-1">
                    Codex <Loader2 size={9} className="animate-spin" />
                  </div>
                  <Markdown content={streamingContent} className="text-[11px]" />
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="p-2 border-t border-border shrink-0">
              <div className="flex gap-1">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleChatSend();
                    }
                  }}
                  placeholder={isSending ? "Waiting…" : "Type to chat…"}
                  rows={2}
                  disabled={isSending}
                  className="flex-1 text-xs bg-transparent border border-border rounded-lg p-2 outline-none resize-none placeholder:text-black/20 disabled:opacity-50"
                />
                <button
                  onClick={handleChatSend}
                  disabled={isSending || !chatInput.trim()}
                  className="self-end p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 disabled:opacity-30 transition-colors"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* Highlight type: just show the header and colored text, no body */}
        {annotation.type === "highlight" && (
          <div className="px-3 py-2">
            <p className="text-[10px] text-muted-foreground">
              Click the color dots above to change color, or the trash icon to remove.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
