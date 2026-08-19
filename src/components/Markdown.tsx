"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { SourceMap } from "@/lib/types";

interface MarkdownProps {
  content: string;
  /** Base text size class, e.g. "text-[13px]" or "text-[11px]" */
  className?: string;
  /** Source map from the retrieval pipeline, keyed by source number */
  sourceMap?: SourceMap;
  /** Callback when a citation badge is clicked — receives the document ID */
  onCiteClick?: (docId: string) => void;
}

/**
 * Pre-process LLM output: convert bare [1], [2] citation markers into
 * markdown links that ReactMarkdown can render, using a custom `cortex-cite:` scheme.
 * Skips numbered markers that are already inside []() links or at the start of a line
 * (which are likely list items or markdown link text).
 */
function injectCitationLinks(text: string, sourceMap: SourceMap): string {
  const sourceNums = Object.keys(sourceMap).map(Number);
  if (sourceNums.length === 0) return text;

  // Match [N] that are NOT followed by ( (which would be a markdown link)
  // and NOT at the start of a line (which could be a list continuation)
  const pattern = new RegExp(
    `(?<!\\()\\[(${sourceNums.join("|")})\\](?!\\()`,
    "g"
  );

  return text.replace(pattern, (_match, num) => {
    return `[${num}](cortex-cite:${num})`;
  });
}

function buildComponents(
  sourceMap?: SourceMap,
  onCiteClick?: (docId: string) => void
): Components {
  return {
    // Paragraphs
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,

    // Headings
    h1: ({ children }) => (
      <h1 className="text-base font-semibold mb-1.5 mt-3 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-sm font-semibold mb-1 mt-2.5 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[13px] font-semibold mb-1 mt-2 first:mt-0">{children}</h3>
    ),

    // Lists
    ul: ({ children }) => (
      <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,

    // Inline code
    code: ({ children, className }) => {
      if (className) {
        return <code className="text-[12px] font-mono">{children}</code>;
      }
      return (
        <code className="px-1 py-0.5 rounded bg-black/[0.06] text-[0.9em] font-mono">
          {children}
        </code>
      );
    },

    // Code blocks
    pre: ({ children }) => (
      <pre className="bg-black/[0.04] rounded-md px-3 py-2 mb-2 overflow-x-auto text-[12px] font-mono leading-relaxed">
        {children}
      </pre>
    ),

    // Bold & italic
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,

    // Links — with citation support
    a: ({ children, href }) => {
      // Citation link: cortex-cite:N
      if (href?.startsWith("cortex-cite:") && sourceMap && onCiteClick) {
        const num = parseInt(href.split(":")[1], 10);
        const source = sourceMap[num];
        if (source) {
          return (
            <button
              onClick={(e) => {
                e.preventDefault();
                onCiteClick(source.docId);
              }}
              title={source.title}
              className="inline-flex items-center justify-center min-w-[1.1em] h-[1.1em] px-[3px] text-[9px] font-semibold leading-none rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors cursor-pointer align-super ml-[1px] -mr-[1px]"
            >
              {num}
            </button>
          );
        }
      }

      // Internal document link: LLM sometimes generates markdown links with
      // document UUIDs as the href (e.g. from tool results). Navigate in-app
      // instead of opening a new tab.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (href && UUID_RE.test(href) && onCiteClick) {
        return (
          <button
            onClick={(e) => {
              e.preventDefault();
              onCiteClick(href);
            }}
            className="text-blue-600 hover:underline cursor-pointer"
          >
            {children}
          </button>
        );
      }

      // External link
      if (href && /^https?:\/\/|^mailto:/i.test(href)) {
        return (
          <a
            href={href}
            className="text-blue-600 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        );
      }

      // Non-external, non-UUID link — render as inert text to avoid
      // navigating away from the app
      return <span className="text-blue-600">{children}</span>;
    },

    // Blockquotes
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-black/15 pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    ),

    // Horizontal rules
    hr: () => <hr className="my-3 border-border" />,

    // Tables
    table: ({ children }) => (
      <div className="overflow-x-auto mb-2">
        <table className="text-[12px] border-collapse w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="border-b border-border">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="text-left px-2 py-1 font-medium text-foreground">{children}</th>
    ),
    td: ({ children }) => (
      <td className="px-2 py-1 border-t border-border/50">{children}</td>
    ),
  };
}

export function Markdown({ content, className = "text-[13px]", sourceMap, onCiteClick }: MarkdownProps) {
  // Pre-process citation markers into links
  const processedContent = useMemo(() => {
    if (!sourceMap || Object.keys(sourceMap).length === 0) return content;
    return injectCitationLinks(content, sourceMap);
  }, [content, sourceMap]);

  // Memoize components so ReactMarkdown doesn't re-mount on every render
  const components = useMemo(
    () => buildComponents(sourceMap, onCiteClick),
    [sourceMap, onCiteClick]
  );

  return (
    <div className={`${className} leading-relaxed [&>*:first-child]:mt-0`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}
