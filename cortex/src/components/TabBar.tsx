"use client";

import { useAppStore } from "@/lib/store";
import { X, FileText } from "lucide-react";

export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);

  if (openTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 overflow-x-auto border-b border-border bg-white">
      {openTabs.map((tab) => {
        const isActive = tab.documentId === activeDocumentId;
        return (
          <div
            key={tab.documentId}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full border cursor-pointer transition-colors shrink-0 ${
              isActive
                ? "border-black/20 bg-white"
                : "border-border hover:border-black/15 bg-transparent"
            }`}
            onClick={() => setActiveTab(tab.documentId)}
          >
            <FileText size={10} className="text-muted-foreground" />
            <span className="text-[10px] text-foreground whitespace-nowrap max-w-[120px] truncate">
              {tab.title}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.documentId);
              }}
              className="ml-1 p-0.5 rounded-full hover:bg-black/10 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
