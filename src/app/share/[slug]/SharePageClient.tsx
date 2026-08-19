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
    <div className="min-h-screen bg-white">
      {/* Top bar */}
      <header className="border-b border-gray-100 sticky top-0 bg-white/80 backdrop-blur-sm z-10">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-400 tracking-wide">
            Codex
          </span>
          <span className="text-xs text-gray-400">Shared note</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-6 py-12">
        {/* Title */}
        <h1 className="text-3xl font-bold text-gray-900 mb-1 leading-tight">
          {data.title || "Untitled"}
        </h1>

        {/* Subtitle */}
        {data.subtitle && (
          <p className="text-lg text-gray-500 mb-4">{data.subtitle}</p>
        )}

        {/* Meta */}
        <div className="flex items-center gap-3 text-xs text-gray-400 mb-8">
          {formattedDate && <span>Updated {formattedDate}</span>}
          {data.tags.length > 0 && (
            <>
              <span className="text-gray-200">·</span>
              <div className="flex gap-1.5">
                {data.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Divider */}
        <hr className="border-gray-100 mb-8" />

        {/* BlockNote read-only view */}
        <div className="share-readonly" style={fontSizeStyle}>
          <ShareCtx.Provider value={shareCtxValue}>
            <BlockNoteView
              editor={editor}
              editable={false}
              theme="light"
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
      <footer className="border-t border-gray-100 mt-16">
        <div className="max-w-2xl mx-auto px-6 py-6 text-center">
          <p className="text-xs text-gray-300">
            Published with{" "}
            <span className="font-medium text-gray-400">Codex</span>
          </p>
        </div>
      </footer>

      {/* "File not public" modal */}
      {showPrivateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setShowPrivateModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl px-6 py-5 max-w-xs text-center space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-2xl">🔒</div>
            <h3 className="text-sm font-semibold text-gray-900">
              This note is private
            </h3>
            <p className="text-xs text-gray-500 leading-relaxed">
              The author hasn&apos;t shared this linked note publicly.
            </p>
            <button
              onClick={() => setShowPrivateModal(false)}
              className="mt-1 px-4 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
