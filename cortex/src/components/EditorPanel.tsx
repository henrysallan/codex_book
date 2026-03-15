"use client";

import dynamic from "next/dynamic";
import { useAppStore } from "@/lib/store";
import { TabBar } from "@/components/TabBar";
import { SearchBar } from "@/components/SearchBar";
import { DocumentEditor } from "@/components/DocumentEditor";
import { BacklinksPanel } from "@/components/BacklinksPanel";
import { Dashboard } from "@/components/Dashboard";
import { Loader2 } from "lucide-react";

const FileViewer = dynamic(() => import("@/components/FileViewer").then((m) => m.FileViewer), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-muted-foreground gap-2">
      <Loader2 size={16} className="animate-spin" /> Loading viewer…
    </div>
  ),
});

interface EditorPanelProps {
  onOpenSearch?: () => void;
}

export function EditorPanel({ onOpenSearch }: EditorPanelProps) {
  const activeDocument = useAppStore((s) => s.activeDocument);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const openTabs = useAppStore((s) => s.openTabs);

  // Check if current tab is a Drive file
  const activeDriveTab = openTabs.find(
    (t) => t.documentId === activeDocumentId && t.driveFile
  );

  // Show dashboard when no document is open
  const showDashboard = !activeDocumentId;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <TabBar />

      {/* Editor area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {showDashboard ? (
          <Dashboard />
        ) : activeDriveTab?.driveFile ? (
          <FileViewer
            key={activeDriveTab.documentId}
            fileId={activeDriveTab.driveFile.fileId}
            fileName={activeDriveTab.title}
            mimeType={activeDriveTab.driveFile.mimeType}
            webViewLink={activeDriveTab.driveFile.webViewLink}
          />
        ) : activeDocument ? (
          <>
            <DocumentEditor key={activeDocument.id} document={activeDocument} />
            <BacklinksPanel />
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
      </div>

      {/* Search bar at bottom */}
      {!showDashboard && <SearchBar onOpenSearch={onOpenSearch} />}
    </div>
  );
}
