"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { EditorPanel } from "@/components/EditorPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { SearchDialog } from "@/components/SearchDialog";
import { LoginScreen } from "@/components/LoginScreen";
import { NotionImport } from "@/components/NotionImport";
import { SettingsModal } from "@/components/SettingsModal";

export default function Home() {
  const { user, isLoading: authLoading } = useAuth();
  const initialize = useAppStore((s) => s.initialize);
  const isLoading = useAppStore((s) => s.isLoading);
  const isChatOpen = useAppStore((s) => s.isChatOpen);

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
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
      // Cmd+P / Ctrl+P => fuzzy finder
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }
      // Cmd+Shift+F / Ctrl+Shift+F => full-text search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
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
      <Sidebar onOpenImport={() => setIsImportOpen(true)} onOpenSettings={() => setIsSettingsOpen(true)} />

      {/* Center Panel - Editor */}
      <div className="flex-1 min-w-0 flex flex-col border-l border-border">
        <EditorPanel onOpenSearch={() => setIsSearchOpen(true)} />
      </div>

      {/* Resize handle + Right Panel - AI Chat */}
      {isChatOpen && (
        <div
          onMouseDown={startResize}
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-black/10 active:bg-black/15 transition-colors"
        />
      )}
      <div
        className="shrink-0 border-l border-border overflow-hidden"
        style={{
          width: isChatOpen ? `${chatWidth}px` : '0px',
          opacity: isChatOpen ? 1 : 0,
          borderLeftWidth: isChatOpen ? '1px' : '0px',
          transition: isResizing.current
            ? 'none'
            : 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease-out, border-left-width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div style={{ width: `${chatWidth}px` }} className="h-full">
          <ChatPanel />
        </div>
      </div>

      {/* Modals */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
      />
      <SearchDialog
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
      <NotionImport
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
