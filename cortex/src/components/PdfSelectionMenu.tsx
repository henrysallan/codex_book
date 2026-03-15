"use client";

/**
 * Floating menu that appears when the user selects text inside a PDF page.
 * Actions: Highlight (with color picker), Add Note, Start Chat.
 */

import { useState } from "react";
import type { PdfAnnotationColor, PdfAnnotationType } from "@/lib/types";
import { Highlighter, StickyNote, MessageSquare } from "lucide-react";

const COLORS: { value: PdfAnnotationColor; bg: string; ring: string }[] = [
  { value: "yellow", bg: "bg-yellow-300", ring: "ring-yellow-400" },
  { value: "green", bg: "bg-green-300", ring: "ring-green-400" },
  { value: "blue", bg: "bg-blue-300", ring: "ring-blue-400" },
  { value: "pink", bg: "bg-pink-300", ring: "ring-pink-400" },
  { value: "purple", bg: "bg-purple-300", ring: "ring-purple-400" },
];

export const HIGHLIGHT_COLORS: Record<PdfAnnotationColor, string> = {
  yellow: "rgba(250, 204, 21, 0.35)",
  green: "rgba(74, 222, 128, 0.35)",
  blue: "rgba(96, 165, 250, 0.35)",
  pink: "rgba(244, 114, 182, 0.35)",
  purple: "rgba(192, 132, 252, 0.35)",
};

interface PdfSelectionMenuProps {
  position: { x: number; y: number };
  onAction: (type: PdfAnnotationType, color: PdfAnnotationColor) => void;
  onDismiss: () => void;
}

export function PdfSelectionMenu({
  position,
  onAction,
  onDismiss,
}: PdfSelectionMenuProps) {
  const [selectedColor, setSelectedColor] = useState<PdfAnnotationColor>("yellow");

  return (
    <>
      {/* Invisible backdrop to catch clicks outside */}
      <div className="fixed inset-0 z-[60]" onClick={onDismiss} />

      <div
        className="fixed z-[61] bg-white rounded-lg shadow-lg border border-border p-1.5 flex items-center gap-1"
        style={{
          left: position.x,
          top: position.y,
          transform: "translate(-50%, -100%) translateY(-8px)",
        }}
      >
        {/* Color dots */}
        <div className="flex items-center gap-0.5 pr-1 border-r border-border mr-1">
          {COLORS.map((c) => (
            <button
              key={c.value}
              onClick={() => setSelectedColor(c.value)}
              className={`w-4 h-4 rounded-full ${c.bg} transition-all ${
                selectedColor === c.value
                  ? `ring-2 ${c.ring} ring-offset-1 scale-110`
                  : "hover:scale-110"
              }`}
              title={c.value}
            />
          ))}
        </div>

        {/* Action buttons */}
        <button
          onClick={() => onAction("highlight", selectedColor)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:bg-black/5 text-foreground transition-colors"
          title="Highlight"
        >
          <Highlighter size={13} />
        </button>
        <button
          onClick={() => onAction("note", selectedColor)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:bg-black/5 text-foreground transition-colors"
          title="Add note"
        >
          <StickyNote size={13} />
        </button>
        <button
          onClick={() => onAction("chat", selectedColor)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:bg-black/5 text-foreground transition-colors"
          title="Start chat"
        >
          <MessageSquare size={13} />
        </button>
      </div>
    </>
  );
}
