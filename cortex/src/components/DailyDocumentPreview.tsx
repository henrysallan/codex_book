"use client";

import { useAppStore } from "@/lib/store";
import { Calendar, ExternalLink } from "lucide-react";

/**
 * Displays today's daily document as a read-only preview in the dashboard.
 * Clicking the header opens it in the editor.
 */
export function DailyDocumentPreview() {
  const dailyDocId = useAppStore((s) => s.dailyDocId);
  const dailyDocTitle = useAppStore((s) => s.dailyDocTitle);
  const dailyDocContent = useAppStore((s) => s.dailyDocContent);
  const openDocument = useAppStore((s) => s.openDocument);

  // Extract plain-text snippets from the content blocks for preview
  const blocks = safeParseBlocks(dailyDocContent);
  const previewLines = extractPreviewLines(blocks, 20);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Calendar size={14} strokeWidth={1.5} className="text-muted-foreground" />
          <h2 className="text-xs font-semibold text-foreground tracking-tight">
            {today}
          </h2>
        </div>
        {dailyDocId && (
          <button
            onClick={() => openDocument(dailyDocId)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Open <ExternalLink size={11} />
          </button>
        )}
      </div>

      {/* Content preview */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {previewLines.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Today&apos;s note is empty. Click &ldquo;Open&rdquo; to start writing.
          </p>
        ) : (
          <div className="space-y-2">
            {previewLines.map((line, i) => (
              <div key={i}>
                {line.type === "heading" ? (
                  <h3 className="text-xs font-medium text-foreground mt-2 first:mt-0">
                    {line.text}
                  </h3>
                ) : (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {line.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────

interface PreviewLine {
  type: "heading" | "paragraph";
  text: string;
}

function safeParseBlocks(content: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((c) => (typeof c === "string" ? c : (c.text as string) || ""))
    .join("");
}

function extractPreviewLines(
  blocks: Record<string, unknown>[],
  maxLines: number
): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const b of blocks) {
    if (lines.length >= maxLines) break;
    const text = extractText(b.content);
    if (!text.trim()) continue;
    const type = (b.type as string)?.startsWith("heading") || b.type === "heading"
      ? "heading"
      : "paragraph";
    lines.push({ type, text });
  }
  return lines;
}
