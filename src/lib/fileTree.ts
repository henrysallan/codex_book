import type { DbDocument, DbFolder, DocType } from "./types";

/**
 * Normalized sidebar tree.
 *
 * The sidebar used to rebuild a nested `Folder[]` object graph on every
 * mutation and every expand/collapse, which defeated memoization and made each
 * toggle re-render the whole tree. Instead we index the raw rows once per data
 * change, sort each parent's children lazily (cached per sort mode), and
 * flatten only the visible rows. Row identity is a string key, so rendering can
 * memoize on primitives.
 *
 * Placement rules (a missing parent falls through to the next rule, so
 * orphaned rows surface instead of vanishing):
 *   doc    → parent doc, else folder, else root
 *   folder → parent folder, else parent doc, else root
 */

export type NodeKind = "folder" | "doc";
/** `folder:<id>` / `doc:<id>` — also the multi-select key. */
export type NodeKey = string;
export const ROOT_KEY = "root";

export const folderKey = (id: string): NodeKey => `folder:${id}`;
export const docKey = (id: string): NodeKey => `doc:${id}`;

export function parseKey(key: NodeKey): { kind: NodeKind; id: string } | null {
  if (key.startsWith("folder:")) return { kind: "folder", id: key.slice(7) };
  if (key.startsWith("doc:")) return { kind: "doc", id: key.slice(4) };
  return null;
}

/** System documents surfaced as pinned buttons, so hidden from the root list. */
export const PINNED_DOC_TYPES: ReadonlySet<DocType> = new Set<DocType>([
  "daily_parent",
  "todo",
  "quick_note_parent",
]);

export interface TreeIndex {
  folders: Map<string, DbFolder>;
  docs: Map<string, DbDocument>;
  /** parent key → child keys (unsorted). */
  children: Map<NodeKey, NodeKey[]>;
  /** child key → parent key. */
  parent: Map<NodeKey, NodeKey>;
}

export function buildTreeIndex(dbFolders: DbFolder[], dbDocuments: DbDocument[]): TreeIndex {
  const folders = new Map<string, DbFolder>();
  const docs = new Map<string, DbDocument>();
  for (const f of dbFolders) folders.set(f.id, f);
  for (const d of dbDocuments) docs.set(d.id, d);

  const children = new Map<NodeKey, NodeKey[]>();
  const parent = new Map<NodeKey, NodeKey>();
  const attach = (parentKey: NodeKey, key: NodeKey) => {
    parent.set(key, parentKey);
    const list = children.get(parentKey);
    if (list) list.push(key);
    else children.set(parentKey, [key]);
  };

  for (const f of dbFolders) {
    const key = folderKey(f.id);
    if (f.parent_id && f.parent_id !== f.id && folders.has(f.parent_id)) {
      attach(folderKey(f.parent_id), key);
    } else if (f.parent_document_id && docs.has(f.parent_document_id)) {
      attach(docKey(f.parent_document_id), key);
    } else {
      attach(ROOT_KEY, key);
    }
  }
  for (const d of dbDocuments) {
    const key = docKey(d.id);
    if (d.parent_document_id && d.parent_document_id !== d.id && docs.has(d.parent_document_id)) {
      attach(docKey(d.parent_document_id), key);
    } else if (d.folder_id && folders.has(d.folder_id)) {
      attach(folderKey(d.folder_id), key);
    } else {
      attach(ROOT_KEY, key);
    }
  }

  return { folders, docs, children, parent };
}

/** Ancestor keys of `key`, nearest first (excludes root). Cycle-safe. */
export function ancestorKeys(index: TreeIndex, key: NodeKey): NodeKey[] {
  const out: NodeKey[] = [];
  const seen = new Set<NodeKey>([key]);
  let cur = index.parent.get(key);
  while (cur && cur !== ROOT_KEY && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = index.parent.get(cur);
  }
  return out;
}

/** All descendant doc ids of a document (sub-pages), for delete warnings. */
export function countDescendantDocs(index: TreeIndex, key: NodeKey): number {
  let n = 0;
  const stack = [...(index.children.get(key) ?? [])];
  const seen = new Set<NodeKey>();
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    if (k.startsWith("doc:")) {
      n++;
      stack.push(...(index.children.get(k) ?? []));
    }
  }
  return n;
}

// ─── Sorting ───

export const SORT_MODES = [
  { value: "manual", label: "Manual" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Modified" },
  { value: "kind", label: "Kind" },
] as const;

export type SortMode = (typeof SORT_MODES)[number]["value"];
export type SortDir = "asc" | "desc";

const DOC_KIND_ORDER: Record<DocType, number> = {
  note: 0,
  moodboard: 1,
  daily: 2,
  daily_parent: 3,
  todo: 4,
  quick_note_parent: 5,
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function folderPrimary(a: DbFolder, b: DbFolder, mode: SortMode): number {
  if (mode === "manual") return a.position - b.position;
  if (mode === "created") return a.created_at.localeCompare(b.created_at);
  if (mode === "updated") return a.updated_at.localeCompare(b.updated_at);
  return collator.compare(a.name, b.name);
}

function docPrimary(a: DbDocument, b: DbDocument, mode: SortMode): number {
  if (mode === "manual") return a.position - b.position;
  if (mode === "created") return a.created_at.localeCompare(b.created_at);
  if (mode === "updated") return a.updated_at.localeCompare(b.updated_at);
  if (mode === "kind") return (DOC_KIND_ORDER[a.doc_type] ?? 99) - (DOC_KIND_ORDER[b.doc_type] ?? 99);
  return collator.compare(a.title || "Untitled", b.title || "Untitled");
}

/**
 * Lazily sorts each parent's children (folders first, then documents) and
 * caches the result. Create one per (index, mode, dir).
 */
export function createChildSorter(index: TreeIndex, mode: SortMode, dir: SortDir) {
  const cache = new Map<NodeKey, NodeKey[]>();
  const mul = dir === "asc" ? 1 : -1;
  return (parentKey: NodeKey): NodeKey[] => {
    const hit = cache.get(parentKey);
    if (hit) return hit;
    const raw = index.children.get(parentKey) ?? [];
    const folderIds: DbFolder[] = [];
    const docRows: DbDocument[] = [];
    for (const k of raw) {
      if (k.startsWith("folder:")) {
        const f = index.folders.get(k.slice(7));
        if (f) folderIds.push(f);
      } else {
        const d = index.docs.get(k.slice(4));
        if (d) docRows.push(d);
      }
    }
    folderIds.sort((a, b) => mul * (folderPrimary(a, b, mode) || collator.compare(a.name, b.name)));
    docRows.sort(
      (a, b) =>
        mul *
        (docPrimary(a, b, mode) || collator.compare(a.title || "Untitled", b.title || "Untitled"))
    );
    const sorted = [...folderIds.map((f) => folderKey(f.id)), ...docRows.map((d) => docKey(d.id))];
    cache.set(parentKey, sorted);
    return sorted;
  };
}

// ─── Flattening ───

export interface TreeRow {
  key: NodeKey;
  kind: NodeKind;
  id: string;
  depth: number;
  parentKey: NodeKey;
  hasChildren: boolean;
  expanded: boolean;
}

export function isExpanded(
  key: NodeKey,
  expandedFolderIds: ReadonlySet<string>,
  expandedDocIds: ReadonlySet<string>
): boolean {
  if (key.startsWith("folder:")) return expandedFolderIds.has(key.slice(7));
  if (key.startsWith("doc:")) return expandedDocIds.has(key.slice(4));
  return false;
}

/** Visible rows in display order — O(visible), cycle-safe. */
export function flattenTree(
  index: TreeIndex,
  sortedChildren: (parentKey: NodeKey) => NodeKey[],
  opts: {
    rootKey: NodeKey;
    expandedFolderIds: ReadonlySet<string>;
    expandedDocIds: ReadonlySet<string>;
  }
): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<NodeKey>();
  const atRoot = opts.rootKey === ROOT_KEY;

  const walk = (parentKey: NodeKey, depth: number) => {
    for (const key of sortedChildren(parentKey)) {
      if (seen.has(key)) continue;
      const isFolder = key.startsWith("folder:");
      const id = isFolder ? key.slice(7) : key.slice(4);
      if (atRoot && depth === 0 && !isFolder) {
        const doc = index.docs.get(id);
        if (doc && PINNED_DOC_TYPES.has(doc.doc_type)) continue;
      }
      seen.add(key);
      const hasChildren = (index.children.get(key)?.length ?? 0) > 0;
      // Folders keep their open state even when empty (chevron + open icon);
      // documents only expand when they have sub-pages.
      const expanded =
        (isFolder || hasChildren) &&
        isExpanded(key, opts.expandedFolderIds, opts.expandedDocIds);
      rows.push({ key, kind: isFolder ? "folder" : "doc", id, depth, parentKey, hasChildren, expanded });
      if (expanded && hasChildren) walk(key, depth + 1);
    }
  };

  walk(opts.rootKey, 0);
  return rows;
}

/** Index one past the last descendant of `rows[i]`. */
export function subtreeEnd(rows: TreeRow[], i: number): number {
  const depth = rows[i].depth;
  let j = i + 1;
  while (j < rows.length && rows[j].depth > depth) j++;
  return j;
}
