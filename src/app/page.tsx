"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAppStore, shouldHandleFileUndo } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { EditorPanel } from "@/components/EditorPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { LoginScreen } from "@/components/LoginScreen";
import { SettingsModal } from "@/components/SettingsModal";

function isNativeField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isEditorTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("[contenteditable='true']"));
}

export default function Home() {
  const { user, isLoading: authLoading } = useAuth();
  const initialize = useAppStore((s) => s.initialize);
  const isLoading = useAppStore((s) => s.isLoading);
  const isChatOpen = useAppStore((s) => s.isChatOpen);

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(320);
  const isResizing = useRef(false);

  // Drag-to-resize handler for chat panel
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 240), 600);
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [chatWidth]);

  // Only initialize store once auth is resolved
  useEffect(() => {
    if (authLoading) return;
    // If Supabase is configured, require a signed-in user before loading data
    if (isSupabaseConfigured() && !user) return;
    initialize();
  }, [initialize, authLoading, user]);

  // Global keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
        if (e.defaultPrevented) return;
        if (isNativeField(e.target)) return;
        const inEditor = isEditorTarget(e.target);
        const { undo, redo } = useAppStore.getState();
        if (e.shiftKey) {
          if (!shouldHandleFileUndo("redo", inEditor)) return;
          e.preventDefault();
          void redo();
        } else {
          if (!shouldHandleFileUndo("undo", inEditor)) return;
          e.preventDefault();
          void undo();
        }
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Show loading while auth is resolving
  if (authLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-white">
        <p className="text-sm text-muted-foreground">Loading&hellip;</p>
      </div>
    );
  }

  // If Supabase is configured but no user, show login
  if (isSupabaseConfigured() && !user) {
    return <LoginScreen />;
  }

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-white">
        <p className="text-sm text-muted-foreground">Loading&hellip;</p>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-white">
      {/* Left Panel - File Tree */}
      <Sidebar onOpenSettings={() => setIsSettingsOpen(true)} />

      {/* Center Panel - Editor */}
      <div className="flex-1 min-w-0 flex flex-col">
        <EditorPanel />
      </div>

      {/* Right Panel - AI Chat */}
      <div
        className="shrink-0 h-full overflow-hidden relative"
        style={{
          width: isChatOpen ? `${chatWidth + 16}px` : "0px",
          opacity: isChatOpen ? 1 : 0,
          transition: isResizing.current
            ? "none"
            : "width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease-out",
        }}
      >
        <div
          onMouseDown={startResize}
          className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10"
        />
        <div className="h-full p-2" style={{ width: `${chatWidth + 16}px` }}>
          <div className="h-full rounded-md border border-border bg-white overflow-hidden">
            <ChatPanel />
          </div>
        </div>
      </div>

      {/* Modals */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
