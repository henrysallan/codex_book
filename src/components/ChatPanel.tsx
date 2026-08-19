"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import {
  Send,
  ChevronDown,
  X,
  FileText,
  Plus,
  TextQuote,
  Loader2,
  Search,
  Copy,
  Check,
  Globe,
  BookOpen,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { SourceMap } from "@/lib/types";

const TOOL_LABELS: Record<string, string> = {
  search_notes: "Searching notes…",
  get_document_info: "Looking up document…",
  read_document_content: "Reading document…",
  list_folder_contents: "Browsing folder…",
  get_backlinks: "Finding linked notes…",
  search_by_date: "Searching by date…",
  get_writing_stats: "Analyzing activity…",
  search_by_tags: "Searching by tags…",
  get_folder_tree: "Mapping folder structure…",
  count_documents: "Counting documents…",
  get_document_lengths: "Measuring note lengths…",
  get_recent_documents: "Finding recent notes…",
  get_document_children: "Listing child documents…",
  get_all_tags: "Gathering all tags…",
  batch_get_document_info: "Looking up documents…",
  get_chunk_summaries: "Reading chunk summaries…",
  find_similar_documents: "Finding similar notes…",
  search_document_content: "Searching content…",
  get_folder_info: "Looking up folder…",
  get_orphan_documents: "Finding orphan notes…",
  get_annotations: "Fetching annotations…",
  get_daily_note: "Looking up daily note…",
  get_tag_graph: "Mapping tag relationships…",
  get_document_hierarchy: "Tracing document tree…",
  compare_documents: "Comparing documents…",
  get_recently_modified: "Finding recent edits…",
  create_note: "Creating note…",
};

interface ChatMeta {
  tier?: string;
  model?: string;
  documentIds?: string[];
  sourceMap?: SourceMap;
}

// ─── Copy button shown on hover for assistant messages ───

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: noop
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute right-0 top-0 opacity-0 group-hover/assistant:opacity-100 transition-opacity p-1 rounded hover:bg-black/[0.06] text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function ChatPanel() {
  const chatMessages = useAppStore((s) => s.chatMessages);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const activeDocument = useAppStore((s) => s.activeDocument);
  const contextItems = useAppStore((s) => s.contextItems);
  const addContextItem = useAppStore((s) => s.addContextItem);
  const removeContextItem = useAppStore((s) => s.removeContextItem);
  const openDocument = useAppStore((s) => s.openDocument);
  const clearContextItems = useAppStore((s) => s.clearContextItems);
  const initialize = useAppStore((s) => s.initialize);
  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("Auto");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [lastMeta, setLastMeta] = useState<ChatMeta | null>(null);
  const [streamingSourceMap, setStreamingSourceMap] = useState<SourceMap | undefined>(undefined);
  const [toolInProgress, setToolInProgress] = useState<string | null>(null);
  const [researchMode, setResearchMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const models = ["Auto", "Claude Haiku", "Claude Sonnet"];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, streamingContent]);

  // Check if the active document is already in context
  const activeDocInContext = activeDocument
    ? contextItems.some(
        (ci) => ci.type === "document" && ci.docId === activeDocument.id
      )
    : false;

  const handleAddActiveDoc = () => {
    if (!activeDocument || activeDocInContext) return;
    addContextItem({
      type: "document",
      docId: activeDocument.id,
      title: activeDocument.title || "Untitled",
    });
  };

  // ─── Send message & stream response ───

  const sendMessage = useCallback(
    async (text: string, tierOverride?: string) => {
      if (isStreaming) return;

      // Only add user message if this isn't a tier escalation
      if (!tierOverride) {
        addChatMessage({ role: "user", content: text });
      }

      // Build message history for the API.
      // For tier escalations ("Look deeper"), resubmit with only the user's
      // original query — NOT the prior assistant reply. Otherwise the request
      // ends with an assistant message, and Anthropic's tool-use loop treats
      // it as a prefill and can hang without producing text.
      const allMessages = tierOverride
        ? [{ role: "user" as const, content: text }]
        : [
            ...chatMessages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: text },
          ];

      setIsStreaming(true);
      setStreamingContent("");
      setStreamingSourceMap(undefined);
      setToolInProgress(null);
      setLastMeta(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Resolve document context items to include their content from the store
        // so the server doesn't need to re-fetch from DB (avoids RLS issues)
        const resolvedContextItems = contextItems.map((ci) => {
          if (ci.type === "document" && ci.docId) {
            // Check active document first, then the cache
            if (activeDocument && activeDocument.id === ci.docId) {
              return { ...ci, content: activeDocument.content };
            }
            const cached = _dbDocuments.find((d) => d.id === ci.docId);
            if (cached?.content) {
              return { ...ci, content: cached.content };
            }
          }
          return ci;
        });

        const requestBody = {
          messages: allMessages,
          activeDocumentId: activeDocument?.id ?? null,
          activeDocumentContent: activeDocument?.content ?? undefined,
          contextItems: resolvedContextItems,
          tier: tierOverride ?? (researchMode ? "GENERAL" : undefined),
          modelOverride: model !== "Auto" ? model : undefined,
        };
        console.log("[ChatPanel] Sending request:", {
          messageCount: allMessages.length,
          activeDocumentId: requestBody.activeDocumentId,
          contextItems: requestBody.contextItems,
          tier: requestBody.tier,
          model: requestBody.modelOverride,
        });

        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`API error: ${res.status}`);

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";
        let meta: ChatMeta = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "meta") {
                meta = {
                  tier: event.tier,
                  model: event.model,
                  documentIds: event.documentIds,
                  sourceMap: event.sourceMap,
                };
                setStreamingSourceMap(event.sourceMap);
              } else if (event.type === "tool_use") {
                setToolInProgress(event.tool);
              } else if (event.type === "text") {
                setToolInProgress(null);
                accumulated += event.content;
                setStreamingContent(accumulated);
              } else if (event.type === "done") {
                meta.tier = event.tier;
                meta.documentIds = event.documentIds;
                if (event.sourceMap) meta.sourceMap = event.sourceMap;
              } else if (event.type === "doc_created") {
                // A note was created by the AI — refresh sidebar
                initialize();
              } else if (event.type === "error") {
                accumulated += `\n\n⚠️ Error: ${event.content}`;
                setStreamingContent(accumulated);
              }
            } catch {
              // skip malformed
            }
          }
        }

        if (accumulated) {
          addChatMessage({ role: "assistant", content: accumulated, sourceMap: meta.sourceMap });
        }
        setLastMeta(meta);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        console.error("[ChatPanel] Stream error:", err);
        addChatMessage({
          role: "assistant",
          content: "Sorry, I wasn't able to generate a response. Please try again.",
        });
      } finally {
        setIsStreaming(false);
        setStreamingContent("");
        setToolInProgress(null);
        abortRef.current = null;
      }
    },
    [isStreaming, chatMessages, activeDocument, contextItems, addChatMessage, initialize]
  );

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
  };

  const handleLookDeeper = () => {
    // Re-send the last user message at TIER2. The streaming UI already shows
    // a "Thinking…" spinner, so we don't need a placeholder assistant message
    // (it would clutter history and never get cleaned up).
    const lastUserMsg = [...chatMessages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMsg) {
      sendMessage(lastUserMsg.content, "TIER2");
    }
  };

  const handleContinueWithContext = () => {
    if (!lastMeta?.documentIds || lastMeta.documentIds.length === 0) return;

    // Load cited documents into context chips
    clearContextItems();
    for (const docId of lastMeta.documentIds) {
      addContextItem({
        type: "document",
        docId,
        title: getDocTitle(docId),
      });
    }
  };

  // ─── Resolve document IDs to titles for citation links ───

  const getDocTitle = (docId: string): string => {
    const doc = _dbDocuments.find((d) => d.id === docId);
    return doc?.title ?? "Untitled";
  };

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Chat messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {chatMessages.length === 0 && !isStreaming && (
          <div className="h-full flex items-center justify-center">
            <p className="text-xs text-muted-foreground text-center">
              Ask questions about your documents.
            </p>
          </div>
        )}
        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`text-sm ${
              msg.role === "user" ? "text-foreground" : "text-muted-foreground group/assistant relative"
            }`}
          >
            <div className="text-[10px] text-muted mb-0.5 uppercase tracking-wider">
              {msg.role === "user" ? "You" : "Cortex"}
            </div>
            {msg.role === "user" ? (
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
                {msg.content}
              </p>
            ) : (
              <>
                <CopyButton text={msg.content} />
                <Markdown
                  content={msg.content}
                  className="text-[13px]"
                  sourceMap={msg.sourceMap}
                  onCiteClick={openDocument}
                />
              </>
            )}
          </div>
        ))}

        {/* Streaming response */}
        {isStreaming && (
          <div className="text-sm text-muted-foreground group/assistant relative pl-6">
            <div className="text-[10px] text-muted mb-0.5 uppercase tracking-wider flex items-center gap-1">
              Cortex
              {!streamingContent && !toolInProgress && (
                <Loader2 size={10} className="animate-spin" />
              )}
            </div>
            {streamingContent ? (
              <Markdown
                content={streamingContent}
                className="text-[13px]"
                sourceMap={streamingSourceMap}
                onCiteClick={openDocument}
              />
            ) : !toolInProgress ? (
              <p className="text-[13px] leading-relaxed">Thinking…</p>
            ) : null}
            {toolInProgress && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1.5 ml-0.5">
                <Loader2 size={10} className="animate-spin" />
                {TOOL_LABELS[toolInProgress] ?? toolInProgress}
              </div>
            )}
          </div>
        )}

        {/* "Look deeper" button — shown when Tier 1 response is done */}
        {!isStreaming && lastMeta?.tier === "TIER1" && chatMessages.length > 0 && (
          <button
            onClick={handleLookDeeper}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-black/[0.03] transition-colors"
          >
            <Search size={12} />
            Look deeper →
          </button>
        )}

        {/* Referenced documents — shown after response */}
        {!isStreaming &&
          lastMeta?.documentIds &&
          lastMeta.documentIds.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex flex-wrap gap-1">
                {lastMeta.documentIds.map((docId) => (
                  <button
                    key={docId}
                    onClick={() => openDocument(docId)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded-md hover:bg-black/[0.03] transition-colors"
                    title={`Open "${getDocTitle(docId)}"`}
                  >
                    <FileText size={10} />
                    <span className="truncate max-w-[140px]">
                      {getDocTitle(docId)}
                    </span>
                  </button>
                ))}
              </div>

              {/* "Continue with context" — loads cited docs into context for Flow 2 */}
              {(lastMeta.tier === "TIER1" || lastMeta.tier === "TIER2") &&
                contextItems.length === 0 && (
                  <button
                    onClick={handleContinueWithContext}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-black/[0.03] transition-colors"
                  >
                    <Plus size={12} />
                    Continue with these docs as context
                  </button>
                )}
            </div>
          )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-border p-3">
        {/* Context chips bar */}
        {(contextItems.length > 0 || activeDocument) && (
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {contextItems.map((item, i) => (
              <span
                key={
                  item.type === "document"
                    ? `doc-${item.docId}`
                    : `blk-${item.blockId}`
                }
                className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-md border border-border bg-black/[0.03] text-[11px] text-foreground max-w-[180px] group"
              >
                {item.type === "document" ? (
                  <FileText size={11} className="shrink-0 text-muted-foreground" />
                ) : (
                  <TextQuote size={11} className="shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {item.type === "document" ? item.title : item.text}
                </span>
                <button
                  onClick={() => removeContextItem(item)}
                  className="shrink-0 p-0.5 rounded hover:bg-black/10 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {/* Add active note button */}
            {activeDocument && !activeDocInContext && (
              <button
                onClick={handleAddActiveDoc}
                className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-md border border-dashed border-border text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                title={`Add "${activeDocument.title || "Untitled"}" to context`}
              >
                <Plus size={11} />
                <span className="truncate max-w-[120px]">
                  {activeDocument.title || "Untitled"}
                </span>
              </button>
            )}
          </div>
        )}

        <div className="border border-border rounded-md p-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={isStreaming ? "Waiting for response…" : researchMode ? "Ask anything…" : "Ask about your notes…"}
            rows={2}
            disabled={isStreaming}
            className="w-full text-sm bg-transparent border-none outline-none resize-none placeholder:text-black/16 disabled:opacity-50"
          />
          <div className="flex items-center justify-between mt-1">
            {/* Model selector */}
            <div className="relative">
              <button
                onClick={() => setShowModelPicker(!showModelPicker)}
                className="flex items-center gap-1 text-sm text-foreground"
              >
                {model}
                <ChevronDown size={12} />
              </button>
              {showModelPicker && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-border rounded shadow-lg py-1 z-10">
                  {models.map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setModel(m);
                        setShowModelPicker(false);
                      }}
                      className={`block w-full text-left px-3 py-1 text-xs hover:bg-black/5 ${
                        m === model ? "font-medium" : ""
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {/* Research mode toggle */}
              <button
                onClick={() => setResearchMode(!researchMode)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                  researchMode
                    ? "bg-blue-50 text-blue-600 border border-blue-200"
                    : "text-muted-foreground hover:text-foreground hover:bg-black/[0.04]"
                }`}
                title={researchMode ? "Research mode: answering from general knowledge" : "Notes mode: searching your knowledge base"}
              >
                {researchMode ? <Globe size={12} /> : <BookOpen size={12} />}
                {researchMode ? "Research" : "Notes"}
              </button>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={!input.trim() || isStreaming}
                className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
