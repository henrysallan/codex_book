"use client";

import { useState, useRef, useCallback } from "react";
import {
  createDocument as dbCreateDocument,
  updateDocument as dbUpdateDocument,
  createFolder as dbCreateFolder,
  syncBacklinks,
} from "@/lib/db";
import { useAppStore } from "@/lib/store";
import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "@/lib/editorSchema";
import {
  X,
  Check,
  Loader2,
  FileText,
  FolderOpen,
  Database,
  Link,
  AlertTriangle,
} from "lucide-react";
import { DatabaseColumn, DatabaseRow, ColumnType } from "@/lib/databaseTypes";
import { v4 as uuidv4 } from "uuid";

// =============================================================================
// Helpers
// =============================================================================

/** Strip the Notion hash suffix and file extension to get a clean title */
function cleanNotionName(filename: string): string {
  const basename = filename.split("/").pop() || filename;
  let name = basename.replace(/\.(md|csv)$/i, "");
  // Remove Notion hash (space + 32 hex chars at end)
  name = name.replace(/ [a-f0-9]{32}$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as-is */
  }
  return name.trim() || "Untitled";
}

/** Clean a Notion directory component name (strip hash) */
function cleanDirName(dirName: string): string {
  let name = dirName.replace(/ [a-f0-9]{32}$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as-is */
  }
  return name.trim() || "Untitled";
}

// ── CSV Parsing ──────────────────────────────────────────────────────────────

/** Parse a standard CSV string (handles quoted fields, commas, escaped quotes) */
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        current.push(field.trim());
        field = "";
      } else if (char === "\n") {
        current.push(field.trim());
        field = "";
        if (current.length > 1 || current[0] !== "") lines.push(current);
        current = [];
      } else if (char !== "\r") {
        field += char;
      }
    }
  }
  current.push(field.trim());
  if (current.length > 1 || current[0] !== "") lines.push(current);
  if (lines.length === 0) return { headers: [], rows: [] };
  return { headers: lines[0], rows: lines.slice(1) };
}

/** Infer the best ColumnType for a set of raw CSV values */
function inferColumnType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v !== "");
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((v) => /^(yes|no|true|false)$/i.test(v)))
    return "checkbox";
  if (nonEmpty.every((v) => !isNaN(Number(v)) && v !== "")) return "number";
  if (
    nonEmpty.every(
      (v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) && !isNaN(Date.parse(v))
    )
  )
    return "date";
  const distinct = new Set(nonEmpty);
  if (distinct.size <= 6 && nonEmpty.length >= 3) return "select";
  return "text";
}

/** Coerce a raw CSV string to a typed CellValue */
function coerceCSVValue(
  raw: string,
  type: ColumnType
): string | number | boolean | null {
  if (raw === "") return null;
  switch (type) {
    case "checkbox":
      return /^(yes|true)$/i.test(raw);
    case "number": {
      const n = parseFloat(raw);
      return isNaN(n) ? null : n;
    }
    default:
      return raw;
  }
}

// ── Markdown Pre-processing ─────────────────────────────────────────────────

/** Convert Notion-style relative links (.md and .csv) to [[wikilinks]] */
function preprocessNotionMarkdown(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\(([^)]+\.(md|csv))\)/g,
    (match, _text, url) => {
      if (url.startsWith("http://") || url.startsWith("https://"))
        return match;
      try {
        const decoded = decodeURIComponent(url);
        const filename = decoded.split("/").pop() || decoded;
        const title = cleanNotionName(filename);
        return `[[${title}]]`;
      } catch {
        return `[[${_text}]]`;
      }
    }
  );
}

// ── Wikilink → pageLink Resolution ──────────────────────────────────────────

type WikiPart =
  | { type: "text"; text: string }
  | { type: "pageLink"; docId: string; title: string };

function splitWikilinks(
  text: string,
  titleToDocId: Map<string, string>
): WikiPart[] {
  const parts: WikiPart[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex)
      parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    const title = match[1];
    const docId = titleToDocId.get(title.toLowerCase().trim());
    if (docId) {
      parts.push({ type: "pageLink", docId, title });
    } else {
      parts.push({ type: "text", text: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length)
    parts.push({ type: "text", text: text.slice(lastIndex) });
  return parts;
}

/**
 * Walk BlockNote JSON and replace [[wikilinks]] in text nodes with pageLink
 * inline content nodes. Returns updated blocks, resolution count, and targets.
 */
function resolveWikilinks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[],
  titleToDocId: Map<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { blocks: any[]; resolved: number; targetDocIds: string[] } {
  let resolved = 0;
  const targetDocIds: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processInline(nodes: any[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any[] = [];
    for (const node of nodes) {
      if (
        node.type === "text" &&
        typeof node.text === "string" &&
        node.text.includes("[[")
      ) {
        const parts = splitWikilinks(node.text, titleToDocId);
        for (const part of parts) {
          if (part.type === "pageLink") {
            result.push({
              type: "pageLink",
              props: { docId: part.docId, docTitle: part.title },
            });
            targetDocIds.push(part.docId);
            resolved++;
          } else if (part.text) {
            result.push({ ...node, text: part.text });
          }
        }
      } else if (node.content && Array.isArray(node.content)) {
        result.push({ ...node, content: processInline(node.content) });
      } else {
        result.push(node);
      }
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processBlocks(blks: any[]): any[] {
    return blks.map((block) => ({
      ...block,
      content: Array.isArray(block.content)
        ? processInline(block.content)
        : block.content,
      children: Array.isArray(block.children)
        ? processBlocks(block.children)
        : block.children,
    }));
  }

  return { blocks: processBlocks(blocks), resolved, targetDocIds };
}

// =============================================================================
// Import Types
// =============================================================================

interface ImportStats {
  foldersCreated: number;
  docsCreated: number;
  databasesCreated: number;
  linksResolved: number;
  errors: string[];
}

type ImportPhase =
  | "idle"
  | "cataloging"
  | "folders"
  | "documents"
  | "databases"
  | "links"
  | "done";

const PHASE_LABELS: Record<ImportPhase, string> = {
  idle: "",
  cataloging: "Scanning files…",
  folders: "Creating folders…",
  documents: "Importing pages…",
  databases: "Importing databases…",
  links: "Resolving links & backlinks…",
  done: "Complete!",
};

// =============================================================================
// Component
// =============================================================================

interface NotionImportProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotionImport({ isOpen, onClose }: NotionImportProps) {
  const initialize = useAppStore((s) => s.initialize);
  const [files, setFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stats, setStats] = useState<ImportStats | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const mdFiles = files.filter((f) => f.name.endsWith(".md"));
  const csvFiles = files.filter((f) => f.name.endsWith(".csv"));

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files || []);
    const relevant = all.filter(
      (f) => f.name.endsWith(".md") || f.name.endsWith(".csv")
    );
    setFiles(relevant);
    setStats(null);
    setPhase("idle");
  };

  // ─── Core Import Logic ───────────────────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (files.length === 0) return;
    setImporting(true);
    setStats(null);

    const importStats: ImportStats = {
      foldersCreated: 0,
      docsCreated: 0,
      databasesCreated: 0,
      linksResolved: 0,
      errors: [],
    };

    try {
      // ═══ Phase 1 — Catalog ═════════════════════════════════════════════
      setPhase("cataloging");

      // Determine root prefix (first path component from webkitRelativePath)
      let rootPrefix = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const samplePath = (files[0] as any).webkitRelativePath as
        | string
        | undefined;
      if (samplePath) {
        const parts = samplePath.split("/");
        if (parts.length > 1) rootPrefix = parts[0] + "/";
      }

      const mdFileMap = new Map<string, File>();
      const csvFileMap = new Map<string, File>();
      const allDirs = new Set<string>();

      // Also track which .md files exist at each directory level (for parent-child detection)
      // Key: directory path where the .md lives, Value: map of "basename without ext" → relPath
      const mdBasenamesByDir = new Map<string, Map<string, string>>();

      for (const file of files) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let relPath =
          ((file as any).webkitRelativePath as string) || file.name;
        if (rootPrefix && relPath.startsWith(rootPrefix)) {
          relPath = relPath.slice(rootPrefix.length);
        }

        // Collect all directory segments
        const pathParts = relPath.split("/").slice(0, -1);
        let dirPath = "";
        for (const part of pathParts) {
          dirPath = dirPath ? `${dirPath}/${part}` : part;
          allDirs.add(dirPath);
        }

        if (file.name.endsWith(".md")) {
          mdFileMap.set(relPath, file);
          // Track basename (with Notion hash, without .md) by parent dir
          const parentDir = pathParts.join("/");
          const basename = file.name.replace(/\.md$/i, "");
          if (!mdBasenamesByDir.has(parentDir)) mdBasenamesByDir.set(parentDir, new Map());
          mdBasenamesByDir.get(parentDir)!.set(basename, relPath);
        } else if (file.name.endsWith(".csv")) {
          csvFileMap.set(relPath, file);
        }
      }

      // ── Detect parent-child directories ────────────────────────────────
      // A directory is a "sub-note dir" if a sibling .md file has the same
      // basename (with Notion hash). e.g.:
      //   Ethics abc123.md   +   Ethics abc123/   → children go under the .md
      const subNoteDirs = new Set<string>(); // full dir paths that are sub-note containers
      const dirToParentMdPath = new Map<string, string>(); // dir path → the parent .md relPath

      for (const dirPath of allDirs) {
        const parts = dirPath.split("/");
        const dirBasename = parts[parts.length - 1]; // e.g. "Ethics abc123"
        const parentDir = parts.slice(0, -1).join("/");
        const siblingsMap = mdBasenamesByDir.get(parentDir);
        if (siblingsMap && siblingsMap.has(dirBasename)) {
          subNoteDirs.add(dirPath);
          dirToParentMdPath.set(dirPath, siblingsMap.get(dirBasename)!);
          // Also mark all descendant dirs as sub-note dirs
          for (const d of allDirs) {
            if (d.startsWith(dirPath + "/")) {
              subNoteDirs.add(d);
              // Descendant dirs map to the same top parent, unless they have their own parent .md
              // We'll handle nested parent-child below
            }
          }
        }
      }

      // For nested sub-note dirs, find the closest parent .md
      // Walk each sub-note dir and find the nearest ancestor that has a parent .md mapping
      for (const dirPath of subNoteDirs) {
        if (dirToParentMdPath.has(dirPath)) continue;
        // Walk up to find closest mapped ancestor
        const parts = dirPath.split("/");
        for (let depth = parts.length - 1; depth >= 1; depth--) {
          const ancestor = parts.slice(0, depth).join("/");
          // Check if this dir level itself has a sibling .md
          const dirBasename = parts[depth - 1]; // wrong — we need the actual dir segment
          // Actually: check if dirPath's own basename matches a sibling .md at its level
          const ownBasename = parts[parts.length - 1];
          const ownParentDir = parts.slice(0, -1).join("/");
          const ownSiblings = mdBasenamesByDir.get(ownParentDir);
          if (ownSiblings && ownSiblings.has(ownBasename)) {
            dirToParentMdPath.set(dirPath, ownSiblings.get(ownBasename)!);
            break;
          }
          // Otherwise it stays as a regular sub-note dir under an ancestor
          break;
        }
      }

      // ═══ Phase 2 — Create Folder Hierarchy (skip sub-note dirs) ════════
      setPhase("folders");
      const dirToFolderId = new Map<string, string>();

      // Only create folders for dirs that are NOT sub-note containers
      const foldersToCreate = [...allDirs]
        .filter((d) => !subNoteDirs.has(d))
        .sort((a, b) => a.split("/").length - b.split("/").length);
      setProgress({ current: 0, total: foldersToCreate.length });

      for (let i = 0; i < foldersToCreate.length; i++) {
        const dirPath = foldersToCreate[i];
        const parts = dirPath.split("/");
        const dirName = cleanDirName(parts[parts.length - 1]);
        const parentPath = parts.slice(0, -1).join("/");
        const parentId = parentPath
          ? dirToFolderId.get(parentPath) || null
          : null;

        try {
          const folder = await dbCreateFolder(dirName, parentId);
          dirToFolderId.set(dirPath, folder.id);
          importStats.foldersCreated++;
        } catch (err) {
          importStats.errors.push(`Folder "${dirName}": ${err}`);
        }
        setProgress({ current: i + 1, total: foldersToCreate.length });
      }

      // ═══ Phase 3 — Import .md Documents ════════════════════════════════
      // Process parent docs first (shallowest paths first) so their IDs
      // are available when we process children.
      setPhase("documents");
      const titleToDocId = new Map<string, string>();
      const createdDocs = new Map<string, string>(); // docId → content JSON
      const relPathToDocId = new Map<string, string>(); // relPath → docId

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tempEditor = BlockNoteEditor.create({ schema } as any);
      // Sort by path depth so parents are created before children
      const mdEntries = [...mdFileMap.entries()].sort(
        (a, b) => a[0].split("/").length - b[0].split("/").length
      );
      setProgress({ current: 0, total: mdEntries.length });

      for (let i = 0; i < mdEntries.length; i++) {
        const [relPath, file] = mdEntries[i];
        try {
          const rawMarkdown = await file.text();
          const title = cleanNotionName(file.name);
          const processedMarkdown = preprocessNotionMarkdown(rawMarkdown);
          const blocks =
            await tempEditor.tryParseMarkdownToBlocks(processedMarkdown);
          const content = JSON.stringify(blocks);

          // Determine if this doc lives inside a sub-note dir
          const dirParts = relPath.split("/").slice(0, -1);
          const dirPath = dirParts.join("/");

          let folderId: string | null = null;
          let parentDocumentId: string | null = null;

          if (dirPath && subNoteDirs.has(dirPath)) {
            // This file is inside a sub-note dir → find the parent .md's docId
            const parentMdPath = dirToParentMdPath.get(dirPath);
            if (parentMdPath && relPathToDocId.has(parentMdPath)) {
              parentDocumentId = relPathToDocId.get(parentMdPath)!;
            }
            // No folder — sub-notes don't go into folders
          } else {
            folderId = dirPath ? dirToFolderId.get(dirPath) || null : null;
          }

          const doc = await dbCreateDocument(folderId, title, content, parentDocumentId);
          titleToDocId.set(title.toLowerCase().trim(), doc.id);
          relPathToDocId.set(relPath, doc.id);
          createdDocs.set(doc.id, content);
          importStats.docsCreated++;
        } catch (err) {
          importStats.errors.push(
            `Page "${cleanNotionName(file.name)}": ${err}`
          );
        }
        setProgress({ current: i + 1, total: mdEntries.length });
      }

      // ═══ Phase 4 — Import .csv Databases ═══════════════════════════════
      setPhase("databases");
      const csvEntries = [...csvFileMap.entries()];
      setProgress({ current: 0, total: csvEntries.length });

      for (let i = 0; i < csvEntries.length; i++) {
        const [relPath, file] = csvEntries[i];
        try {
          const csvText = await file.text();
          const { headers, rows } = parseCSV(csvText);
          if (headers.length === 0) continue;

          // Infer column types
          const columnTypes: ColumnType[] = headers.map((_, colIdx) => {
            const values = rows.map((r) => r[colIdx] || "");
            return inferColumnType(values);
          });

          // Build columns
          const columns: DatabaseColumn[] = headers.map((header, idx) => ({
            id: uuidv4(),
            name: header,
            type: columnTypes[idx],
            width: idx === 0 ? 250 : 180,
            isTitle: idx === 0,
          }));

          // Populate select configs
          for (const col of columns) {
            if (col.type === "select") {
              const colIdx = columns.indexOf(col);
              const values = rows
                .map((r) => r[colIdx] || "")
                .filter((v) => v !== "");
              col.config = { options: [...new Set(values)] };
            }
          }

          // Build rows, linking to imported docs where titles match
          const dbRows: DatabaseRow[] = rows.map((row) => {
            const cells: Record<string, string | number | boolean | null> = {};
            columns.forEach((col, idx) => {
              cells[col.id] = coerceCSVValue(row[idx] || "", col.type);
            });
            const titleValue = (row[0] || "").trim();
            const docId = titleToDocId.get(titleValue.toLowerCase().trim());
            return { id: uuidv4(), docId: docId || undefined, cells };
          });

          // Build document with a single database block
          const databaseContent = [
            {
              id: uuidv4(),
              type: "database",
              props: {
                columns: JSON.stringify(columns),
                rows: JSON.stringify(dbRows),
              },
              content: [],
              children: [],
            },
          ];

          const dirParts = relPath.split("/").slice(0, -1);
          const dirPath = dirParts.join("/");
          const folderId = dirPath
            ? dirToFolderId.get(dirPath) || null
            : null;

          const title = cleanNotionName(file.name);
          const content = JSON.stringify(databaseContent);
          const doc = await dbCreateDocument(folderId, title, content);
          titleToDocId.set(title.toLowerCase().trim(), doc.id);
          createdDocs.set(doc.id, content);
          importStats.databasesCreated++;
        } catch (err) {
          importStats.errors.push(
            `Database "${cleanNotionName(file.name)}": ${err}`
          );
        }
        setProgress({ current: i + 1, total: csvEntries.length });
      }

      // ═══ Phase 5 — Resolve [[wikilinks]] → pageLink & sync backlinks ═══
      setPhase("links");
      const docEntries = [...createdDocs.entries()];
      setProgress({ current: 0, total: docEntries.length });

      for (let i = 0; i < docEntries.length; i++) {
        const [docId, contentJson] = docEntries[i];
        try {
          let blocks: unknown[];
          try {
            blocks = JSON.parse(contentJson);
          } catch {
            continue;
          }
          if (!Array.isArray(blocks)) continue;

          const {
            blocks: resolved,
            resolved: count,
            targetDocIds,
          } = resolveWikilinks(blocks, titleToDocId);

          if (count > 0) {
            const newContent = JSON.stringify(resolved);
            await dbUpdateDocument(docId, { content: newContent });
            importStats.linksResolved += count;
            // Sync backlinks
            const uniqueTargets = [...new Set(targetDocIds)];
            await syncBacklinks(docId, uniqueTargets);
          }
        } catch (err) {
          importStats.errors.push(`Link resolution: ${err}`);
        }
        setProgress({ current: i + 1, total: docEntries.length });
      }

      // ═══ Done ══════════════════════════════════════════════════════════
      setPhase("done");
      setStats(importStats);
      await initialize();
    } catch (err) {
      importStats.errors.push(`Fatal: ${err}`);
      setStats(importStats);
      setPhase("done");
    } finally {
      setImporting(false);
    }
  }, [files, initialize]);

  const handleClose = useCallback(() => {
    if (importing) return;
    setFiles([]);
    setStats(null);
    setPhase("idle");
    onClose();
  }, [importing, onClose]);

  if (!isOpen) return null;

  const progressPct =
    progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !importing) handleClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[520px] max-h-[650px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">
            Import from Notion
          </h2>
          <button
            onClick={handleClose}
            disabled={importing}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {!stats && (
            <p className="text-sm text-muted-foreground">
              Export your Notion workspace as{" "}
              <strong>Markdown &amp; CSV</strong>, unzip the archive, then
              select the exported folder below. Pages, databases, folders, and
              internal links will all be imported.
            </p>
          )}

          {/* Folder picker */}
          {!stats && (
            <div
              className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderOpen
                size={24}
                className="mx-auto mb-2 text-muted-foreground"
              />
              <p className="text-sm text-muted-foreground">
                Click to select your{" "}
                <strong>Notion export folder</strong>
              </p>
              <input
                ref={folderInputRef}
                type="file"
                /* @ts-expect-error webkitdirectory is non-standard but widely supported */
                webkitdirectory=""
                directory=""
                onChange={handleFolderSelect}
                className="hidden"
              />
            </div>
          )}

          {/* File summary */}
          {files.length > 0 && !importing && !stats && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-foreground">
                <FileText size={14} className="text-blue-500" />
                <span>
                  {mdFiles.length} page{mdFiles.length !== 1 ? "s" : ""}
                </span>
              </div>
              {csvFiles.length > 0 && (
                <div className="flex items-center gap-2 text-foreground">
                  <Database size={14} className="text-green-500" />
                  <span>
                    {csvFiles.length} database
                    {csvFiles.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {files.length} total file{files.length !== 1 ? "s" : ""}{" "}
                detected
              </p>
            </div>
          )}

          {/* Progress */}
          {importing && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Loader2 size={14} className="animate-spin text-blue-500" />
                <span>{PHASE_LABELS[phase]}</span>
              </div>
              {progress.total > 0 && (
                <div className="space-y-1">
                  <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-200"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-right">
                    {progress.current} / {progress.total}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {stats && (
            <div className="space-y-3">
              <div
                className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
                  stats.errors.length === 0
                    ? "bg-green-50 text-green-700"
                    : "bg-yellow-50 text-yellow-700"
                }`}
              >
                <Check size={16} />
                <span>Import complete</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex items-center gap-2 text-foreground">
                  <FolderOpen size={14} className="text-amber-500" />
                  <span>
                    {stats.foldersCreated} folder
                    {stats.foldersCreated !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-foreground">
                  <FileText size={14} className="text-blue-500" />
                  <span>
                    {stats.docsCreated} page
                    {stats.docsCreated !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-foreground">
                  <Database size={14} className="text-green-500" />
                  <span>
                    {stats.databasesCreated} database
                    {stats.databasesCreated !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-foreground">
                  <Link size={14} className="text-purple-500" />
                  <span>
                    {stats.linksResolved} link
                    {stats.linksResolved !== 1 ? "s" : ""} resolved
                  </span>
                </div>
              </div>

              {stats.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-amber-600">
                    <AlertTriangle size={12} />
                    <span>
                      {stats.errors.length} warning
                      {stats.errors.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="max-h-[100px] overflow-y-auto text-xs text-muted-foreground bg-gray-50 rounded p-2 space-y-0.5">
                    {stats.errors.map((err, i) => (
                      <p key={i} className="truncate">
                        {err}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleClose}
            disabled={importing}
            className="px-4 py-2 text-sm text-foreground hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            {stats ? "Done" : "Cancel"}
          </button>
          {!stats && (
            <button
              onClick={handleImport}
              disabled={files.length === 0 || importing}
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-2"
            >
              {importing && <Loader2 size={14} className="animate-spin" />}
              {importing
                ? "Importing…"
                : `Import ${files.length} file${files.length !== 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
