import { TitleIndex } from "../resolve";
import type { ColumnType, DatabaseColumn, DatabaseRow } from "@/lib/databaseTypes";
import { v4 as uuidv4 } from "uuid";

/** Strip the Notion hash suffix and file extension to get a clean title */
export function cleanNotionName(filename: string): string {
  const basename = filename.split("/").pop() || filename;
  let name = basename.replace(/\.(md|markdown|csv)$/i, "");
  name = name.replace(/ [a-f0-9]{32}$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as-is */
  }
  return name.trim() || "Untitled";
}

/** Clean a Notion directory component name (strip hash) */
export function cleanDirName(dirName: string): string {
  let name = dirName.replace(/ [a-f0-9]{32}$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as-is */
  }
  return name.trim() || "Untitled";
}

/**
 * Strip the 32-hex Notion hash from every path segment so
 * `Ethics abc123.md` + `Ethics abc123/Child.md` become `Ethics.md` + `Ethics/Child.md`.
 */
export function normalizeNotionPath(relPath: string): string {
  return relPath
    .split("/")
    .filter(Boolean)
    .map((part) => {
      let decoded = part;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        /* keep as-is */
      }
      const extMatch = decoded.match(/^(.+)(\.[^.]+)$/);
      if (extMatch) {
        return extMatch[1].replace(/ [a-f0-9]{32}$/i, "") + extMatch[2];
      }
      return decoded.replace(/ [a-f0-9]{32}$/i, "");
    })
    .join("/");
}

/** Convert Notion-style relative links (.md and .csv) to [[wikilinks]] */
export function preprocessNotionMarkdown(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\(([^)]+\.(md|markdown|csv))\)/gi,
    (match, _text, url) => {
      if (url.startsWith("http://") || url.startsWith("https://")) return match;
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

/**
 * A directory is a sub-note container when a sibling `.md` has the same basename.
 * Returns dir path → parent .md relative path. Nested dirs map to the closest parent.
 */
export function detectSubNoteDirs(mdPaths: string[]): Map<string, string> {
  const mdSet = new Set(mdPaths);
  const allDirs = new Set<string>();
  for (const p of mdPaths) {
    const parts = p.split("/").slice(0, -1);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      allDirs.add(acc);
    }
  }

  const dirToParent = new Map<string, string>();
  for (const dir of allDirs) {
    const parts = dir.split("/");
    for (let depth = parts.length; depth >= 1; depth--) {
      const candidate = `${parts.slice(0, depth).join("/")}.md`;
      if (mdSet.has(candidate)) {
        dirToParent.set(dir, candidate);
        break;
      }
    }
  }
  return dirToParent;
}

export function parseCSV(text: string): { headers: string[]; rows: string[][] } {
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

function inferColumnType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v !== "");
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((v) => /^(yes|no|true|false)$/i.test(v))) return "checkbox";
  if (nonEmpty.every((v) => !isNaN(Number(v)) && v !== "")) return "number";
  if (
    nonEmpty.every(
      (v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) && !isNaN(Date.parse(v))
    )
  ) {
    return "date";
  }
  const distinct = new Set(nonEmpty);
  if (distinct.size <= 6 && nonEmpty.length >= 3) return "select";
  return "text";
}

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

export function csvToDatabaseContent(
  csvText: string,
  index: TitleIndex
): string | null {
  const { headers, rows } = parseCSV(csvText);
  if (headers.length === 0) return null;

  const columnTypes: ColumnType[] = headers.map((_, colIdx) => {
    const values = rows.map((r) => r[colIdx] || "");
    return inferColumnType(values);
  });

  const columns: DatabaseColumn[] = headers.map((header, idx) => ({
    id: uuidv4(),
    name: header,
    type: columnTypes[idx],
    width: idx === 0 ? 250 : 180,
    isTitle: idx === 0,
  }));

  for (const col of columns) {
    if (col.type === "select") {
      const colIdx = columns.indexOf(col);
      const values = rows.map((r) => r[colIdx] || "").filter((v) => v !== "");
      col.config = { options: [...new Set(values)] };
    }
  }

  const dbRows: DatabaseRow[] = rows.map((row) => {
    const cells: Record<string, string | number | boolean | null> = {};
    columns.forEach((col, idx) => {
      cells[col.id] = coerceCSVValue(row[idx] || "", col.type);
    });
    const titleValue = (row[0] || "").trim();
    const docId = titleValue ? index.lookup(titleValue) : undefined;
    return { id: uuidv4(), docId: docId || undefined, cells };
  });

  return JSON.stringify([
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
  ]);
}
