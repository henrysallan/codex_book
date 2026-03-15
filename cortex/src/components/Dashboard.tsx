"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { TodoWidget } from "@/components/TodoWidget";
import { QuickNoteWidget } from "@/components/QuickNoteWidget";
import { DailyDocumentPreview } from "@/components/DailyDocumentPreview";
import { Loader2 } from "lucide-react";

/**
 * Dashboard / home screen shown when no document is open.
 * Two-column layout:
 *   Left   — Quick Notes + Todo widgets stacked (~1/4 width)
 *   Center — Today's daily document (flex-1)
 */
export function Dashboard() {
  const dashboardReady = useAppStore((s) => s.dashboardReady);
  const initDashboard = useAppStore((s) => s.initDashboard);

  useEffect(() => {
    initDashboard();
  }, [initDashboard]);

  if (!dashboardReady) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Loading dashboard…</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Three-column body */}
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        {/* Left — Quick Notes + Todo stacked */}
        <div className="w-72 shrink-0 flex flex-col gap-2">
          <div className="rounded-md border border-border bg-white overflow-hidden flex flex-col max-h-[50%]">
            <QuickNoteWidget />
          </div>
          <div className="flex-1 min-h-0 rounded-md border border-border bg-white overflow-hidden flex flex-col">
            <TodoWidget />
          </div>
        </div>

        {/* Center — Daily Document */}
        <div className="flex-1 min-w-0 rounded-md bg-white overflow-hidden flex flex-col">
          <DailyDocumentPreview />
        </div>
      </div>
    </div>
  );
}

