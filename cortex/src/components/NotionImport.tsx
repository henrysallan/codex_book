"use client";

import { useState, useRef, useCallback } from "react";
import {
  createDocument as dbCreateDocument,
  updateDocument as dbUpdateDocument,
} from "@/lib/db";
import { useAppStore } from "@/lib/store";
import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "@/lib/editorSchema";
import { X, Upload, FileText, Check, Loader2 } from "lucide-react";

interface NotionImportProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Strip the Notion hash suffix and .md extension from a filename to get a clean title */
function titleFromNotionFilename(filename: string): string {
  // Remove directory path
  const basename = filename.split("/").pop() || filename;
  // Remove .md extension
  let title = basename.replace(/\.md$/i, "");
  // Remove Notion hash (space + 32 hex chars at end)
  title = title.replace(/ [a-f0-9]{32}$/i, "");
  // URL-decode
  try {
    title = decodeURIComponent(title);
  } catch {
    // keep as-is
  }
  return title.trim() || "Untitled";
}

/** Convert Notion-style relative markdown links to [[wikilinks]] */
function preprocessNotionMarkdown(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\(([^)]*\.md)\)/g,
    (match, text, url) => {
      // Only convert relative links (not http/https)
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return match;
      }
      return `[[${text}]]`;
    }
  );
}

export function NotionImport({ isOpen, onClose }: NotionImportProps) {
  const initialize = useAppStore((s) => s.initialize);
  const [files, setFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<{
    total: number;
    success: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []).filter((f) =>
      f.name.endsWith(".md")
    );
    setFiles(selected);
    setResults(null);
  };

  const handleImport = useCallback(async () => {
    if (files.length === 0) return;

    setImporting(true);
    setResults(null);
    let success = 0;

    try {
      // Create a temporary headless editor for markdown → blocks conversion
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tempEditor = BlockNoteEditor.create({ schema } as any);

      for (const file of files) {
        try {
          const rawMarkdown = await file.text();
          const title = titleFromNotionFilename(file.name);
          const processedMarkdown = preprocessNotionMarkdown(rawMarkdown);

          // Convert markdown to BlockNote blocks
          const blocks =
            await tempEditor.tryParseMarkdownToBlocks(processedMarkdown);
          const content = JSON.stringify(blocks);

          // Create the document in the database with content
          await dbCreateDocument(null, title, content);

          success++;
        } catch (err) {
          console.error(`Failed to import ${file.name}:`, err);
        }
      }

      // Refresh the store so the sidebar shows the new documents
      await initialize();
      setResults({ total: files.length, success });
    } catch (err) {
      console.error("Import failed:", err);
      setResults({ total: files.length, success });
    } finally {
      setImporting(false);
    }
  }, [files, initialize]);

  const handleClose = useCallback(() => {
    setFiles([]);
    setResults(null);
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[480px] max-h-[600px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            Import from Notion
          </h2>
          <button
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Export your Notion workspace as{" "}
            <strong>Markdown &amp; CSV</strong>, then select the{" "}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
              .md
            </code>{" "}
            files below. Internal links will be converted to [[wikilinks]].
          </p>

          {/* File picker */}
          <div
            className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload
              size={24}
              className="mx-auto mb-2 text-muted-foreground"
            />
            <p className="text-sm text-muted-foreground">
              Click to select <strong>.md</strong> files
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm text-foreground py-1"
                >
                  <FileText
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                  <span className="truncate">
                    {titleFromNotionFilename(f.name)}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-1">
                {files.length} file{files.length !== 1 ? "s" : ""} selected
              </p>
            </div>
          )}

          {/* Results */}
          {results && (
            <div
              className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
                results.success === results.total
                  ? "bg-green-50 text-green-700"
                  : "bg-yellow-50 text-yellow-700"
              }`}
            >
              <Check size={16} />
              <span>
                Imported {results.success} of {results.total} document
                {results.total !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm text-foreground hover:bg-gray-100 rounded-lg transition-colors"
          >
            {results ? "Done" : "Cancel"}
          </button>
          {!results && (
            <button
              onClick={handleImport}
              disabled={files.length === 0 || importing}
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-2"
            >
              {importing && <Loader2 size={14} className="animate-spin" />}
              {importing
                ? "Importing..."
                : `Import ${files.length} file${files.length !== 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
