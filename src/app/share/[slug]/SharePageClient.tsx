"use client";

import { useState, useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { shareSchema, ShareCtx } from "@/lib/shareSchema";
import * as locales from "@blocknote/core/locales";
import {
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useResolvedTheme } from "@/lib/theme";
import type { ShareData } from "./page";

interface Props {
  data: ShareData;
}

/**
 * Client component for the public share page.
 * Renders the note using BlockNoteView in read-only mode so the output
 * is pixel-perfect with the editor — just non-editable and non-interactive.
 */
export function SharePageClient({ data }: Props) {
  const theme = useResolvedTheme();
  const [showPrivateModal, setShowPrivateModal] = useState(false);

  // Parse blocks from the document content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialContent = useMemo<any[] | undefined>(() => {
    try {
      const parsed = JSON.parse(data.content);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
    return undefined;
  }, [data.content]);

  const editor = useCreateBlockNote({
    schema: shareSchema,
    initialContent,
    dropCursor: multiColumnDropCursor,
    dictionary: {
      ...locales.en,
      multi_column: multiColumnLocales.en,
    },
  });

  const formattedDate = useMemo(() => {
    try {
      return new Date(data.updatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }, [data.updatedAt]);

  const shareCtxValue = useMemo(
    () => ({
      pageLinkMap: data.pageLinkMap,
      onPrivateLink: () => setShowPrivateModal(true),
    }),
    [data.pageLinkMap]
  );

  // Apply note font size from settings
  const fontSize = (data.settings as Record<string, unknown>)?.fontSize;
  const fontSizeStyle = fontSize
    ? ({ "--note-font-size": `${fontSize}px` } as React.CSSProperties)
    : undefined;

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b border-ink/5 sticky top-0 bg-background/80 backdrop-blur-sm z-10">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center justify-between">
          <span className="text-sm font-medium text-muted tracking-wide">
            Codex
          </span>
          <span className="text-xs text-muted">Shared note</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-6 py-12">
        {/* Title */}
        <h1 className="text-3xl font-bold text-foreground mb-1 leading-tight">
          {data.title || "Untitled"}
        </h1>

        {/* Subtitle */}
        {data.subtitle && (
          <p className="text-lg text-muted-foreground mb-4">{data.subtitle}</p>
        )}

        {/* Meta */}
        <div className="flex items-center gap-3 text-xs text-muted mb-8">
          {formattedDate && <span>Updated {formattedDate}</span>}
          {data.tags.length > 0 && (
            <>
              <span className="text-ink/10">·</span>
              <div className="flex gap-1.5">
                {data.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-full bg-ink/5 text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Divider */}
        <hr className="border-ink/5 mb-8" />

        {/* BlockNote read-only view */}
        <div className="share-readonly" style={fontSizeStyle}>
          <ShareCtx.Provider value={shareCtxValue}>
            <BlockNoteView
              editor={editor}
              editable={false}
              theme={theme}
              sideMenu={false}
              formattingToolbar={false}
              slashMenu={false}
              emojiPicker={false}
              filePanel={false}
              tableHandles={false}
            />
          </ShareCtx.Provider>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-ink/5 mt-16">
        <div className="max-w-2xl mx-auto px-6 py-6 text-center">
          <p className="text-xs text-ink/20">
            Published with{" "}
            <span className="font-medium text-muted">Codex</span>
          </p>
        </div>
      </footer>

      {/* "File not public" modal */}
      {showPrivateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm"
          onClick={() => setShowPrivateModal(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-xl px-6 py-5 max-w-xs text-center space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-2xl">🔒</div>
            <h3 className="text-sm font-semibold text-foreground">
              This note is private
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The author hasn&apos;t shared this linked note publicly.
            </p>
            <button
              onClick={() => setShowPrivateModal(false)}
              className="mt-1 px-4 py-1.5 text-xs font-medium bg-foreground text-background rounded-lg hover:bg-foreground/85 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
