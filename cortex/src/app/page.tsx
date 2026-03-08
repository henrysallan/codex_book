"use client";

import { useEffect, useState, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { EditorPanel } from "@/components/EditorPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { SearchDialog } from "@/components/SearchDialog";
import { LoginScreen } from "@/components/LoginScreen";

export default function Home() {
  const { user, isLoading: authLoading } = useAuth();
  const initialize = useAppStore((s) => s.initialize);
  const isLoading = useAppStore((s) => s.isLoading);
  const isChatOpen = useAppStore((s) => s.isChatOpen);

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

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
      <Sidebar />

      {/* Center Panel - Editor */}
      <div className="flex-1 min-w-0 flex flex-col border-l border-border">
        <EditorPanel onOpenSearch={() => setIsSearchOpen(true)} />
      </div>

      {/* Right Panel - AI Chat */}
      {isChatOpen && (
        <div className="w-[320px] shrink-0 border-l border-border">
          <ChatPanel />
        </div>
      )}

      {/* Modals */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
      />
      <SearchDialog
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </div>
  );
}
