"use client";

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { Send, ChevronDown } from "lucide-react";

export function ChatPanel() {
  const chatMessages = useAppStore((s) => s.chatMessages);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const activeDocument = useAppStore((s) => s.activeDocument);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("Claude Opus 4.6");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const models = ["Claude Opus 4.6", "Claude Sonnet 4", "Claude Haiku"];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;

    addChatMessage({ role: "user", content: text });
    setInput("");

    // Simulated AI response (Phase 3 will connect to real API)
    setTimeout(() => {
      addChatMessage({
        role: "assistant",
        content: `I received your message: "${text}". AI integration will be available in Phase 3.${
          activeDocument
            ? ` I can see you're working on "${activeDocument.title}".`
            : ""
        }`,
      });
    }, 500);
  };

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Chat messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {chatMessages.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <p className="text-xs text-muted-foreground text-center">
              Ask questions about your documents.
              <br />
              AI chat coming in Phase 3.
            </p>
          </div>
        )}
        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`text-sm ${
              msg.role === "user" ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            <div className="text-[10px] text-muted mb-0.5 uppercase tracking-wider">
              {msg.role === "user" ? "You" : "Cortex"}
            </div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
              {msg.content}
            </p>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-border p-3">
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
            placeholder="Type to chat...."
            rows={2}
            className="w-full text-sm bg-transparent border-none outline-none resize-none placeholder:text-black/16"
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

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
