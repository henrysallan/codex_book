"use client";

import { useState, useMemo, useCallback } from "react";
import { blocksToMarkdown } from "@/lib/blocksToMarkdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ShareData } from "./page";

interface Props {
  data: ShareData;
}

/**
 * Client component for the public share page.
 * Renders the note as beautiful Markdown with a standalone layout.
 * Handles pageLink clicks: shared pages navigate, unshared show a modal.
 */
export function SharePageClient({ data }: Props) {
  const [showPrivateModal, setShowPrivateModal] = useState(false);

  // Convert blocks to markdown, preserving pageLink references
  const markdown = useMemo(() => blocksToMarkdown(data.content), [data.content]);

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

  // Build custom components that handle cortex-page: links
  const handlePageLinkClick = useCallback(
    (docId: string) => {
      const slug = data.pageLinkMap[docId];
      if (slug) {
        window.open(`/share/${slug}`, "_blank");
      } else {
        setShowPrivateModal(true);
      }
    },
    [data.pageLinkMap]
  );

  const components: Components = useMemo(
    () => ({
      p: ({ children }) => (
        <p className="mb-4 last:mb-0 leading-[1.75]">{children}</p>
      ),
      h1: ({ children }) => (
        <h1 className="text-2xl font-bold mb-4 mt-8 first:mt-0 text-gray-900">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="text-xl font-semibold mb-3 mt-6 first:mt-0 text-gray-900">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="text-lg font-semibold mb-2 mt-5 first:mt-0 text-gray-900">
          {children}
        </h3>
      ),
      ul: ({ children }) => (
        <ul className="list-disc pl-6 mb-4 space-y-1">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="list-decimal pl-6 mb-4 space-y-1">{children}</ol>
      ),
      li: ({ children }) => (
        <li className="leading-[1.75]">{children}</li>
      ),
      code: ({ children, className }) => {
        if (className) {
          return <code className="text-sm font-mono">{children}</code>;
        }
        return (
          <code className="px-1.5 py-0.5 rounded bg-gray-100 text-[0.9em] font-mono text-gray-800">
            {children}
          </code>
        );
      },
      pre: ({ children }) => (
        <pre className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-4 overflow-x-auto text-sm font-mono leading-relaxed">
          {children}
        </pre>
      ),
      strong: ({ children }) => (
        <strong className="font-semibold text-gray-900">{children}</strong>
      ),
      em: ({ children }) => <em className="italic">{children}</em>,
      a: ({ children, href }) => {
        // Handle pageLink references: cortex-page:<docId>
        if (href?.startsWith("cortex-page:")) {
          const docId = href.replace("cortex-page:", "");
          return (
            <button
              onClick={(e) => {
                e.preventDefault();
                handlePageLinkClick(docId);
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors cursor-pointer font-medium text-[0.95em]"
            >
              {children}
            </button>
          );
        }

        // Regular external link
        return (
          <a
            href={href}
            className="text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 hover:decoration-blue-500 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        );
      },
      blockquote: ({ children }) => (
        <blockquote className="border-l-[3px] border-gray-300 pl-4 my-4 text-gray-600 italic">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-8 border-gray-200" />,
      table: ({ children }) => (
        <div className="overflow-x-auto mb-4">
          <table className="text-sm border-collapse w-full">{children}</table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="border-b-2 border-gray-200">{children}</thead>
      ),
      th: ({ children }) => (
        <th className="text-left px-3 py-2 font-medium text-gray-900">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="px-3 py-2 border-t border-gray-100">{children}</td>
      ),
    }),
    [handlePageLinkClick]
  );

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

        {/* Body */}
        <article className="text-base text-gray-800 leading-[1.75] [&>*:first-child]:mt-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {markdown}
          </ReactMarkdown>
        </article>
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
