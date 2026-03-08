"use client";

import { useAppStore } from "@/lib/store";
import { TabBar } from "@/components/TabBar";
import { SearchBar } from "@/components/SearchBar";
import { DocumentEditor } from "@/components/DocumentEditor";
import { BacklinksPanel } from "@/components/BacklinksPanel";
import { FileText } from "lucide-react";

interface EditorPanelProps {
  onOpenSearch?: () => void;
}

export function EditorPanel({ onOpenSearch }: EditorPanelProps) {
  const activeDocument = useAppStore((s) => s.activeDocument);
  const openTabs = useAppStore((s) => s.openTabs);
  const createDocument = useAppStore((s) => s.createDocument);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <TabBar />

      {/* Editor area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeDocument ? (
          <>
            <DocumentEditor key={activeDocument.id} document={activeDocument} />
            <BacklinksPanel />
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <FileText size={40} strokeWidth={1} />
            <p className="text-sm">No document open</p>
            <button
              onClick={() => createDocument(null)}
              className="text-xs px-3 py-1.5 rounded-full border border-border hover:border-black/20 transition-colors text-foreground"
            >
              Create new document
            </button>
          </div>
        )}
      </div>

      {/* Search bar at bottom */}
      <SearchBar onOpenSearch={onOpenSearch} />
    </div>
  );
}
