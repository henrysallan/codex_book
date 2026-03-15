"use client";

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { X, MessageSquare, Trash2, Loader2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";

export function AnnotationChat() {
  const activeAnnotation = useAppStore((s) => s.activeAnnotation);
  const closeAnnotationChat = useAppStore((s) => s.closeAnnotationChat);
  const addAnnotationMessage = useAppStore((s) => s.addAnnotationMessage);
  const deleteAnnotationById = useAppStore((s) => s.deleteAnnotationById);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeAnnotation?.messages, streamingContent]);

  if (!activeAnnotation) return null;

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    await addAnnotationMessage(text, "user");

    // Build the full message history for the API
    const allMessages = [
      ...activeAnnotation.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: text },
    ];

    setIsStreaming(true);
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/ai/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotationId: activeAnnotation.id,
          documentId: activeAnnotation.documentId,
          highlightedText: activeAnnotation.highlightedText,
          messages: allMessages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === "text") {
              accumulated += event.content;
              setStreamingContent(accumulated);
            } else if (event.type === "error") {
              console.error("[AnnotationChat] Stream error:", event.content);
              accumulated += `\n\n⚠️ Error: ${event.content}`;
              setStreamingContent(accumulated);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Persist the final assistant message
      if (accumulated) {
        await addAnnotationMessage(accumulated, "assistant");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.error("[AnnotationChat] Failed to get AI response:", err);
      await addAnnotationMessage(
        "Sorry, I wasn't able to generate a response. Please try again.",
        "assistant"
      );
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      abortRef.current = null;
    }
  };

  // Clean up on close
  const handleClose = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    closeAnnotationChat();
  };

  return (
    <div className="w-[280px] bg-white rounded-xl border border-border shadow-lg flex flex-col max-h-[400px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border rounded-t-xl">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <MessageSquare size={12} />
          Annotation
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => deleteAnnotationById(activeAnnotation.id)}
            className="p-0.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500 transition-colors"
            title="Delete annotation"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={handleClose}
            className="p-0.5 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Highlighted text context */}
      <div className="px-3 py-2 border-b border-border bg-yellow-50/60">
        <p className="text-[11px] text-foreground leading-relaxed line-clamp-3">
          &ldquo;{activeAnnotation.highlightedText}&rdquo;
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {activeAnnotation.messages.length === 0 && !isStreaming && (
          <p className="text-[11px] text-muted-foreground text-center mt-2">
            Ask a question about this text.
          </p>
        )}
        {activeAnnotation.messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs ${
              msg.role === "user"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
          >
            <div className="text-[9px] text-muted mb-0.5 uppercase tracking-wider">
              {msg.role === "user" ? "You" : "Cortex"}
            </div>
            {msg.role === "user" ? (
              <p className="text-[11px] leading-relaxed whitespace-pre-wrap">
                {msg.content}
              </p>
            ) : (
              <Markdown content={msg.content} className="text-[11px]" />
            )}
          </div>
        ))}

        {/* Streaming AI response */}
        {isStreaming && (
          <div className="text-xs text-muted-foreground">
            <div className="text-[9px] text-muted mb-0.5 uppercase tracking-wider flex items-center gap-1">
              Cortex
              {!streamingContent && (
                <Loader2 size={9} className="animate-spin" />
              )}
            </div>
            {streamingContent ? (
              <Markdown content={streamingContent} className="text-[11px]" />
            ) : (
              <p className="text-[11px] leading-relaxed">Thinking…</p>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-2 rounded-b-xl">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={isStreaming ? "Waiting for response…" : "Type to chat...."}
          rows={2}
          disabled={isStreaming}
          className="w-full text-xs bg-transparent border border-border rounded-lg p-2 outline-none resize-none placeholder:text-black/20 disabled:opacity-50"
        />
      </div>
    </div>
  );
}
