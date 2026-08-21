import { supabase, isSupabaseConfigured } from "./supabase";
import { localDateTag, dateTagsForLookup, dayContainerTitle } from "./dateTag";
import { DbDocument, DbFolder, Document, DocumentMeta, Folder, SearchResult, Backlink, DbBacklink, DbAnnotation, AnnotationMessage, DbAttachment, Attachment, DbPdfAnnotation, PdfAnnotation, PdfAnnotationColor, PdfAnnotationType, TextAnchor, GraphLayout } from "./types";
import { v4 as uuidv4 } from "uuid";

// ============================================================
// Auth Helper — resolve current user ID
// ============================================================

async function getCurrentUserId(): Promise<string> {
  if (!isSupabaseConfigured() || !supabase) return "local";
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? "local";
}

// ============================================================
// Local Storage Helpers (fallback when Supabase is not configured)
// ============================================================

const FOLDERS_KEY = "cortex_folders";
const DOCUMENTS_KEY = "cortex_documents";

function getLocalFolders(): DbFolder[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalFolders(folders: DbFolder[]) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

function getLocalDocuments(): DbDocument[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(DOCUMENTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalDocuments(docs: DbDocument[]) {
  localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(docs));
}

const PAGE_SIZE = 1000;

async function fetchAllPages<T>(
  run: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await run(from, to);
    if (error) throw error;
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (value == null) return fallback;
  return value as T;
}

// ============================================================
// Folder Operations
// ============================================================

export async function fetchFolders(): Promise<DbFolder[]> {
  if (!isSupabaseConfigured()) return getLocalFolders();

  return fetchAllPages((from, to) =>
    supabase!
      .from("folders")
      .select(
        "id, name, parent_id, parent_document_id, user_id, position, created_at, updated_at"
      )
      .order("id", { ascending: true })
      .range(from, to)
  );
}

export async function createFolder(
  name: string,
  parentId: string | null = null
): Promise<DbFolder> {
  const now = new Date().toISOString();
  const userId = await getCurrentUserId();
  const folder: DbFolder = {
    id: uuidv4(),
    name,
    parent_id: parentId,
    parent_document_id: null,
    user_id: userId,
    position: 0,
    created_at: now,
    updated_at: now,
  };

  if (!isSupabaseConfigured()) {
    const folders = getLocalFolders();
    folders.push(folder);
    setLocalFolders(folders);
    return folder;
  }

  const { data, error } = await supabase!
    .from("folders")
    .insert(folder)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function renameFolder(
  id: string,
  name: string
): Promise<DbFolder> {
  if (!isSupabaseConfigured()) {
    const folders = getLocalFolders();
    const idx = folders.findIndex((f) => f.id === id);
    if (idx >= 0) {
      folders[idx].name = name;
      folders[idx].updated_at = new Date().toISOString();
      setLocalFolders(folders);
      return folders[idx];
    }
    throw new Error("Folder not found");
  }

  const { data, error } = await supabase!
    .from("folders")
    .update({ name })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteFolder(id: string): Promise<void> {
  // Delete the folder only. Direct child folders are reparented to this
  // folder's parent; documents that lived in this folder go to root.
  if (!isSupabaseConfigured()) {
    const allFolders = getLocalFolders();
    const folder = allFolders.find((f) => f.id === id);
    const hoistParent = folder?.parent_id ?? null;
    for (const f of allFolders) {
      if (f.parent_id === id) f.parent_id = hoistParent;
    }
    const allDocs = getLocalDocuments();
    for (const d of allDocs) {
      if (d.folder_id === id) d.folder_id = null;
    }
    setLocalFolders(allFolders.filter((f) => f.id !== id));
    setLocalDocuments(allDocs);
    return;
  }

  const { data: folder, error: fetchErr } = await supabase!
    .from("folders")
    .select("parent_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  const hoistParent = folder?.parent_id ?? null;

  const { error: hoistFoldersErr } = await supabase!
    .from("folders")
    .update({ parent_id: hoistParent })
    .eq("parent_id", id);
  if (hoistFoldersErr) throw hoistFoldersErr;

  const { error: hoistDocsErr } = await supabase!
    .from("documents")
    .update({ folder_id: null })
    .eq("folder_id", id);
  if (hoistDocsErr) throw hoistDocsErr;

  const { error } = await supabase!.from("folders").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// Document Operations
// ============================================================

// Metadata-only columns for sidebar tree building (excludes heavy `content` and `settings`).
// Full content is fetched on-demand via fetchDocument() when a doc is opened.
const DOCUMENT_META_COLUMNS =
  "id, title, subtitle, folder_id, parent_document_id, user_id, tags, doc_type, position, share_slug, created_at, updated_at";

/** Content for the editor — still excludes embedding, fts, and other AI blobs. */
const DOCUMENT_CONTENT_COLUMNS = `${DOCUMENT_META_COLUMNS}, content, settings, ai_summary, ai_tags, content_hash, index_status`;

export async function fetchDocuments(): Promise<DbDocument[]> {
  if (!isSupabaseConfigured()) return getLocalDocuments();

  const rows = await fetchAllPages<Omit<DbDocument, "content" | "settings">>(
    (from, to) =>
      supabase!
        .from("documents")
        .select(DOCUMENT_META_COLUMNS)
        .order("id", { ascending: true })
        .range(from, to)
  );

  return rows.map((d) => ({
    ...d,
    content: "[]",
    settings: {},
  })) as DbDocument[];
}

export async function fetchDocument(id: string): Promise<DbDocument | null> {
  if (!isSupabaseConfigured()) {
    return getLocalDocuments().find((d) => d.id === id) ?? null;
  }

  const { data, error } = await supabase!
    .from("documents")
    .select(DOCUMENT_CONTENT_COLUMNS)
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return data;
}

export async function createDocument(
  folderId: string | null = null,
  title: string = "Untitled",
  content: string = "[]",
  parentDocumentId: string | null = null,
  docType: import("./types").DocType = "note",
  tags: string[] = []
): Promise<DbDocument> {
  const now = new Date().toISOString();
  const userId = await getCurrentUserId();
  const doc: DbDocument = {
    id: uuidv4(),
    title,
    subtitle: null,
    folder_id: folderId,
    parent_document_id: parentDocumentId,
    user_id: userId,
    content,
    tags,
    settings: {},
    doc_type: docType,
    position: 0,
    share_slug: null,
    created_at: now,
    updated_at: now,
  };

  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    docs.push(doc);
    setLocalDocuments(docs);
    return doc;
  }

  const { data, error } = await supabase!
    .from("documents")
    .insert({
      id: doc.id,
      title: doc.title,
      folder_id: doc.folder_id,
      parent_document_id: doc.parent_document_id,
      user_id: doc.user_id,
      content: doc.content,
      tags: doc.tags,
      settings: doc.settings,
      doc_type: doc.doc_type,
      position: doc.position,
    })
    .select(DOCUMENT_CONTENT_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateDocument(
  id: string,
  updates: Partial<{
    title: string;
    subtitle: string | null;
    content: string;
    tags: string[];
    folder_id: string | null;
    settings: import("./types").NoteSettings;
    share_slug: string | null;
  }>,
  opts?: { expectedUpdatedAt?: string }
): Promise<DbDocument> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx >= 0) {
      if (
        opts?.expectedUpdatedAt &&
        docs[idx].updated_at &&
        docs[idx].updated_at !== opts.expectedUpdatedAt
      ) {
        throw new StaleWriteError(docs[idx]);
      }
      docs[idx] = { ...docs[idx], ...updates, updated_at: new Date().toISOString() };
      setLocalDocuments(docs);
      return docs[idx];
    }
    throw new Error("Document not found");
  }

  const payload: Record<string, unknown> = { ...updates };
  if (updates.content !== undefined) {
    payload.index_status = "stale";
  }

  let query = supabase!.from("documents").update(payload).eq("id", id);
  if (opts?.expectedUpdatedAt) {
    query = query.eq("updated_at", opts.expectedUpdatedAt);
  }

  const { data, error } = await query.select(DOCUMENT_CONTENT_COLUMNS).maybeSingle();

  if (error) throw error;
  if (!data) {
    const { data: current } = await supabase!
      .from("documents")
      .select(DOCUMENT_CONTENT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (current) throw new StaleWriteError(current as DbDocument);
    throw new Error("Document not found");
  }
  return data;
}

/** Thrown when a write's expected `updated_at` no longer matches the row. */
export class StaleWriteError extends Error {
  current: DbDocument;
  constructor(current: DbDocument) {
    super("Document was modified elsewhere");
    this.name = "StaleWriteError";
    this.current = current;
  }
}

/**
 * Best-effort PATCH that survives tab close (`keepalive`). Used from
 * `pagehide` / `beforeunload` when a debounced save has not flushed yet.
 */
export function keepalivePatchDocument(
  id: string,
  updates: Partial<{
    title: string;
    subtitle: string | null;
    content: string;
  }>,
  expectedUpdatedAt?: string | null
): void {
  if (!isSupabaseConfigured() || !supabase) {
    void updateDocument(
      id,
      updates,
      expectedUpdatedAt ? { expectedUpdatedAt } : undefined
    ).catch(() => {});
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  void supabase.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token;
    if (!token || !url || !anon) {
      void updateDocument(
        id,
        updates,
        expectedUpdatedAt ? { expectedUpdatedAt } : undefined
      ).catch(() => {});
      return;
    }

    const params = new URLSearchParams();
    params.set("id", `eq.${id}`);
    if (expectedUpdatedAt) {
      params.set("updated_at", `eq.${expectedUpdatedAt}`);
    }

    const body: Record<string, unknown> = { ...updates };
    if (updates.content !== undefined) body.index_status = "stale";

    fetch(`${url}/rest/v1/documents?${params.toString()}`, {
      method: "PATCH",
      keepalive: true,
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  });
}

export async function deleteDocument(id: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    const allDocs = getLocalDocuments();
    const idsToDelete = new Set<string>();
    const collect = (docId: string) => {
      idsToDelete.add(docId);
      for (const d of allDocs) {
        if (d.parent_document_id === docId) collect(d.id);
      }
    };
    collect(id);
    setLocalDocuments(allDocs.filter((d) => !idsToDelete.has(d.id)));
    return;
  }

  // Recursively collect child docs (sub-notes)
  const idsToDelete = new Set<string>([id]);
  const collectChildren = async (parentIds: string[]) => {
    const { data: children } = await supabase!
      .from("documents")
      .select("id")
      .in("parent_document_id", parentIds);
    if (children && children.length > 0) {
      const newIds = children.map((c) => c.id).filter((cid) => !idsToDelete.has(cid));
      for (const cid of newIds) idsToDelete.add(cid);
      if (newIds.length > 0) await collectChildren(newIds);
    }
  };
  await collectChildren([id]);

  const { error } = await supabase!
    .from("documents")
    .delete()
    .in("id", [...idsToDelete]);
  if (error) throw error;
}

/** Move a document into a folder (or to root if folderId is null) */
export async function moveDocument(
  docId: string,
  folderId: string | null
): Promise<void> {
  await updateDocument(docId, { folder_id: folderId });
}

/** Move a folder under another folder, under a document, or to root */
export async function moveFolder(
  folderId: string,
  parentId: string | null,
  parentDocumentId: string | null = null
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const folders = getLocalFolders();
    const idx = folders.findIndex((f) => f.id === folderId);
    if (idx >= 0) {
      folders[idx].parent_id = parentId;
      folders[idx].parent_document_id = parentDocumentId;
      folders[idx].updated_at = new Date().toISOString();
      setLocalFolders(folders);
    }
    return;
  }

  const { error } = await supabase!
    .from("folders")
    .update({ parent_id: parentId, parent_document_id: parentDocumentId })
    .eq("id", folderId);
  if (error) throw error;
}

/** Set or clear a document's parent document (sub-note relationship) */
export async function setParentDocument(
  docId: string,
  parentDocId: string | null
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx >= 0) {
      docs[idx].parent_document_id = parentDocId;
      // When nesting under a parent doc, inherit its folder_id
      if (parentDocId) {
        const parent = docs.find((d) => d.id === parentDocId);
        if (parent) docs[idx].folder_id = parent.folder_id;
      }
      docs[idx].updated_at = new Date().toISOString();
      setLocalDocuments(docs);
    }
    return;
  }

  const updates: Record<string, unknown> = { parent_document_id: parentDocId };
  // When nesting under a parent, inherit its folder so it stays in the same tree branch
  if (parentDocId) {
    const parent = await fetchDocument(parentDocId);
    if (parent) updates.folder_id = parent.folder_id;
  }
  const { error } = await supabase!
    .from("documents")
    .update(updates)
    .eq("id", docId);
  if (error) throw error;
}

// ---------- Tree Building ----------

export function buildFolderTree(
  dbFolders: DbFolder[],
  dbDocuments: DbDocument[],
  expandedFolderIds: Set<string>
): Folder[] {
  const folderMap = new Map<string, Folder>();

  // Create folder nodes
  for (const f of dbFolders) {
    folderMap.set(f.id, {
      id: f.id,
      name: f.name,
      parentId: f.parent_id,
      parentDocumentId: f.parent_document_id ?? null,
      position: f.position,
      isExpanded: expandedFolderIds.has(f.id),
      children: [],
      documents: [],
    });
  }

  // Build a lookup of all documents as DocumentMeta
  const allMeta = new Map<string, DocumentMeta>();
  for (const d of dbDocuments) {
    allMeta.set(d.id, {
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      folderId: d.folder_id,
      parentDocumentId: d.parent_document_id,
      tags: d.tags,
      docType: d.doc_type ?? "note",
      position: d.position,
      shareSlug: d.share_slug ?? null,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      childDocuments: [],
      childFolders: [],
    });
  }

  // Wire up child documents (parent_document_id nesting)
  for (const meta of allMeta.values()) {
    if (meta.parentDocumentId && allMeta.has(meta.parentDocumentId)) {
      const parent = allMeta.get(meta.parentDocumentId)!;
      if (!parent.childDocuments) parent.childDocuments = [];
      parent.childDocuments.push(meta);
    }
  }

  // Assign top-level documents (no parent_document_id) to folders
  for (const d of dbDocuments) {
    if (d.parent_document_id) continue; // skip children — they're nested
    if (d.folder_id && folderMap.has(d.folder_id)) {
      folderMap.get(d.folder_id)!.documents.push(allMeta.get(d.id)!);
    }
  }

  // Build tree — wire folder→folder and folder→document parents
  const roots: Folder[] = [];
  for (const folder of folderMap.values()) {
    if (folder.parentId && folderMap.has(folder.parentId)) {
      // Nested under another folder
      folderMap.get(folder.parentId)!.children.push(folder);
    } else if (folder.parentDocumentId && allMeta.has(folder.parentDocumentId)) {
      // Nested under a document
      const parentDoc = allMeta.get(folder.parentDocumentId)!;
      if (!parentDoc.childFolders) parentDoc.childFolders = [];
      parentDoc.childFolders.push(folder);
    } else {
      roots.push(folder);
    }
  }

  return roots;
}

export function getRootDocuments(dbDocuments: DbDocument[], dbFolders: DbFolder[] = []): DocumentMeta[] {
  // Build a lookup of all documents as DocumentMeta
  const allMeta = new Map<string, DocumentMeta>();
  for (const d of dbDocuments) {
    allMeta.set(d.id, {
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      folderId: d.folder_id,
      parentDocumentId: d.parent_document_id,
      tags: d.tags,
      docType: d.doc_type ?? "note",
      position: d.position,
      shareSlug: d.share_slug ?? null,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      childDocuments: [],
      childFolders: [],
    });
  }

  // Wire up child documents recursively (arbitrary depth)
  for (const meta of allMeta.values()) {
    if (meta.parentDocumentId && allMeta.has(meta.parentDocumentId)) {
      const parent = allMeta.get(meta.parentDocumentId)!;
      if (!parent.childDocuments) parent.childDocuments = [];
      parent.childDocuments.push(meta);
    }
  }

  // Wire folders that are nested under root documents
  for (const f of dbFolders) {
    if (f.parent_document_id && !f.parent_id && allMeta.has(f.parent_document_id)) {
      const parentDoc = allMeta.get(f.parent_document_id)!;
      if (!parentDoc.childFolders) parentDoc.childFolders = [];
      parentDoc.childFolders.push({
        id: f.id,
        name: f.name,
        parentId: f.parent_id,
        parentDocumentId: f.parent_document_id,
        position: f.position,
        isExpanded: false,
        children: [],
        documents: [],
      });
    }
  }

  // Return only root-level docs (no folder, no parent doc)
  return dbDocuments
    .filter((d) => !d.folder_id && !d.parent_document_id)
    .map((d) => allMeta.get(d.id)!);
}

export function dbDocumentToDocument(db: DbDocument): Document {
  return {
    id: db.id,
    title: db.title,
    subtitle: db.subtitle,
    folderId: db.folder_id,
    parentDocumentId: db.parent_document_id,
    tags: db.tags,
    docType: db.doc_type ?? "note",
    settings: db.settings ?? {},
    position: db.position,
    shareSlug: db.share_slug ?? null,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    content: db.content,
  };
}

// ============================================================
// Search
// ============================================================

function extractTextFromContent(content: string): string {
  try {
    const blocks = JSON.parse(content);
    const texts: string[] = [];
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === "string") texts.push(obj.text);
      if (Array.isArray(obj.content)) obj.content.forEach(walk);
      if (Array.isArray(obj.children)) obj.children.forEach(walk);
    }
    if (Array.isArray(blocks)) blocks.forEach(walk);
    return texts.join(" ");
  } catch {
    return "";
  }
}

export async function searchDocuments(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  if (!isSupabaseConfigured()) {
    // Local search: simple case-insensitive substring match
    const docs = getLocalDocuments();
    const q = query.toLowerCase();
    return docs
      .map((d) => {
        const text = extractTextFromContent(d.content);
        const haystack = `${d.title} ${d.subtitle || ""} ${d.tags.join(" ")} ${text}`.toLowerCase();
        const idx = haystack.indexOf(q);
        if (idx === -1) return null;
        // Build a snippet around the match
        const snippetStart = Math.max(0, idx - 40);
        const snippetEnd = Math.min(haystack.length, idx + query.length + 40);
        const snippet = haystack.slice(snippetStart, snippetEnd);
        return {
          id: d.id,
          title: d.title,
          subtitle: d.subtitle,
          tags: d.tags,
          snippet: snippet,
          rank: idx === 0 ? 1 : 0.5,
        } as SearchResult;
      })
      .filter((r): r is SearchResult => r !== null)
      .sort((a, b) => b.rank - a.rank);
  }

  // Supabase full-text search using the RPC function.
  // The RPC returns a server-side `ts_headline` snippet (no full content),
  // so we only egress title/subtitle/tags/snippet per result.
  // p_user_id is ignored when a user JWT is present (auth.uid() wins);
  // it is required for service-role callers.
  const userId = await getCurrentUserId();
  const { data, error } = await supabase!.rpc("search_documents", {
    search_query: query,
    ...(userId !== "local" ? { p_user_id: userId } : {}),
  });

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    title: row.title as string,
    subtitle: row.subtitle as string | null,
    tags: (row.tags as string[]) || [],
    snippet: (row.snippet as string | null) ?? "",
    rank: row.rank as number,
  }));
}

// ============================================================
// Annotations
// ============================================================

const ANNOTATIONS_KEY = "cortex_annotations";

function getLocalAnnotations(): DbAnnotation[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(ANNOTATIONS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalAnnotations(annotations: DbAnnotation[]) {
  localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify(annotations));
}

export async function fetchAnnotations(documentId: string): Promise<DbAnnotation[]> {
  if (!isSupabaseConfigured()) {
    return getLocalAnnotations().filter((a) => a.document_id === documentId);
  }

  // Exclude `messages` from the list fetch — the document editor only needs
  // highlight metadata for rendering markers. Full chat history is loaded
  // on-demand when the user opens a specific annotation via fetchAnnotation(id).
  const { data, error } = await supabase!
    .from("annotations")
    .select("id, document_id, user_id, block_id, highlighted_text, created_at, updated_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...(row as Omit<DbAnnotation, "messages">),
    messages: [] as AnnotationMessage[],
  })) as DbAnnotation[];
}

export async function fetchAnnotation(id: string): Promise<DbAnnotation | null> {
  if (!isSupabaseConfigured()) {
    return getLocalAnnotations().find((a) => a.id === id) ?? null;
  }

  const { data, error } = await supabase!
    .from("annotations")
    .select("id, document_id, user_id, block_id, highlighted_text, messages, summary, created_at, updated_at")
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  const row = data as Record<string, unknown>;
  return {
    ...row,
    messages: parseJsonField<AnnotationMessage[]>(row.messages, []),
  } as DbAnnotation;
}

export async function createAnnotation(
  documentId: string,
  blockId: string | null,
  highlightedText: string
): Promise<DbAnnotation> {
  const now = new Date().toISOString();
  const userId = await getCurrentUserId();
  const annotation: DbAnnotation = {
    id: uuidv4(),
    document_id: documentId,
    user_id: userId,
    block_id: blockId,
    highlighted_text: highlightedText,
    messages: [],
    created_at: now,
    updated_at: now,
  };

  if (!isSupabaseConfigured()) {
    const annotations = getLocalAnnotations();
    annotations.push(annotation);
    setLocalAnnotations(annotations);
    return annotation;
  }

  const { data, error } = await supabase!
    .from("annotations")
    .insert({
      id: annotation.id,
      document_id: annotation.document_id,
      user_id: annotation.user_id,
      block_id: annotation.block_id,
      highlighted_text: annotation.highlighted_text,
      messages: annotation.messages,
    })
    .select()
    .single();

  if (error) throw error;
  return {
    ...data,
    messages: parseJsonField<AnnotationMessage[]>(
      (data as { messages?: unknown }).messages,
      []
    ),
  } as DbAnnotation;
}

export async function updateAnnotationMessages(
  id: string,
  messages: AnnotationMessage[]
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const annotations = getLocalAnnotations();
    const idx = annotations.findIndex((a) => a.id === id);
    if (idx >= 0) {
      annotations[idx].messages = messages;
      annotations[idx].updated_at = new Date().toISOString();
      setLocalAnnotations(annotations);
    }
    return;
  }

  const { error } = await supabase!
    .from("annotations")
    .update({ messages })
    .eq("id", id);

  if (error) throw error;
}

export async function deleteAnnotation(id: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    const annotations = getLocalAnnotations().filter((a) => a.id !== id);
    setLocalAnnotations(annotations);
    return;
  }

  const { error } = await supabase!.from("annotations").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// Page-link title propagation
// ============================================================

/** Walk BlockNote JSON and update docTitle for all pageLink nodes matching docId.
 *  Returns updated content string, or null if nothing changed. */
function updatePageLinkTitlesInContent(
  content: string,
  docId: string,
  newTitle: string
): string | null {
  try {
    const blocks = JSON.parse(content);
    let changed = false;
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (
        obj.type === "pageLink" &&
        obj.props &&
        (obj.props as Record<string, unknown>).docId === docId
      ) {
        if ((obj.props as Record<string, unknown>).docTitle !== newTitle) {
          (obj.props as Record<string, unknown>).docTitle = newTitle;
          changed = true;
        }
      }
      if (Array.isArray(obj.content)) obj.content.forEach(walk);
      if (Array.isArray(obj.children)) obj.children.forEach(walk);
    }
    if (Array.isArray(blocks)) blocks.forEach(walk);
    return changed ? JSON.stringify(blocks) : null;
  } catch {
    return null;
  }
}

/** Update the displayed title in all pageLink nodes across every document that links to docId */
export async function propagatePageLinkTitle(
  docId: string,
  newTitle: string
): Promise<void> {
  // Only fetch documents whose content actually contains this docId
  const candidateDocs = isSupabaseConfigured()
    ? (await supabase!
        .from("documents")
        .select("id, content")
        .like("content", `%${docId}%`)
        .then((r) => r.data)) ?? []
    : getLocalDocuments().filter((d) => d.content.includes(docId));

  for (const doc of candidateDocs) {
    const d = doc as { id: string; content: string };
    const updated = updatePageLinkTitlesInContent(d.content, docId, newTitle);
    if (updated) {
      await updateDocument(d.id, { content: updated });
    }
  }
}

// ============================================================
// Database row title propagation
// ============================================================

/** Walk BlockNote JSON and update the title cell in any database block row that links to docId.
 *  The "title cell" is the first column's cell value for a row whose docId matches.
 *  Returns updated content string, or null if nothing changed. */
function updateDatabaseRowTitleInContent(
  content: string,
  docId: string,
  newTitle: string
): string | null {
  try {
    const blocks = JSON.parse(content);
    let changed = false;
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (
        obj.type === "database" &&
        obj.props &&
        typeof (obj.props as Record<string, unknown>).columns === "string" &&
        typeof (obj.props as Record<string, unknown>).rows === "string"
      ) {
        const props = obj.props as Record<string, unknown>;
        try {
          const columns = JSON.parse(props.columns as string) as { id: string }[];
          const rows = JSON.parse(props.rows as string) as { id: string; docId?: string; cells: Record<string, unknown> }[];
          const firstColId = columns[0]?.id;
          if (!firstColId) return;

          let rowsChanged = false;
          for (const row of rows) {
            if (row.docId === docId && row.cells[firstColId] !== newTitle) {
              row.cells[firstColId] = newTitle;
              rowsChanged = true;
            }
          }
          if (rowsChanged) {
            props.rows = JSON.stringify(rows);
            changed = true;
          }
        } catch {
          // skip malformed database props
        }
      }
      if (Array.isArray(obj.content)) obj.content.forEach(walk);
      if (Array.isArray(obj.children)) obj.children.forEach(walk);
    }
    if (Array.isArray(blocks)) blocks.forEach(walk);
    return changed ? JSON.stringify(blocks) : null;
  } catch {
    return null;
  }
}

/** Update the title cell in all database block rows across every document that references docId */
export async function propagateDatabaseRowTitle(
  docId: string,
  newTitle: string
): Promise<void> {
  // Only fetch documents whose content actually contains this docId
  const candidateDocs = isSupabaseConfigured()
    ? (await supabase!
        .from("documents")
        .select("id, content")
        .like("content", `%${docId}%`)
        .then((r) => r.data)) ?? []
    : getLocalDocuments().filter((d) => d.content.includes(docId));

  for (const doc of candidateDocs) {
    const d = doc as { id: string; content: string };
    const updated = updateDatabaseRowTitleInContent(d.content, docId, newTitle);
    if (updated) {
      await updateDocument(d.id, { content: updated });
    }
  }
}

// ============================================================
// Backlinks
// ============================================================

const BACKLINKS_KEY = "cortex_backlinks";

function getLocalBacklinks(): DbBacklink[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BACKLINKS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalBacklinks(links: DbBacklink[]) {
  localStorage.setItem(BACKLINKS_KEY, JSON.stringify(links));
}

/** Walk BlockNote JSON content and extract docId from any pageLink inline nodes */
function extractPageLinkIds(content: string): string[] {
  try {
    const blocks = JSON.parse(content);
    const ids: string[] = [];
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (
        obj.type === "pageLink" &&
        obj.props &&
        typeof (obj.props as Record<string, unknown>).docId === "string"
      ) {
        ids.push((obj.props as Record<string, unknown>).docId as string);
      }
      if (Array.isArray(obj.content)) obj.content.forEach(walk);
      if (Array.isArray(obj.children)) obj.children.forEach(walk);
    }
    if (Array.isArray(blocks)) blocks.forEach(walk);
    return ids;
  } catch {
    return [];
  }
}

/** Parse [[wikilinks]] and pageLink nodes from BlockNote JSON content and return matched document IDs */
export function parseBacklinks(
  content: string,
  allDocuments: DbDocument[]
): string[] {
  const text = extractTextFromContent(content);
  const regex = /\[\[([^\]]+)\]\]/g;
  const linkedTitles = new Set<string>();
  let match;
  while ((match = regex.exec(text)) !== null) {
    linkedTitles.add(match[1].toLowerCase().trim());
  }

  const ids = new Set<string>();

  // Resolve wikilink titles to document IDs
  if (linkedTitles.size > 0) {
    const titleToId = new Map<string, string>();
    for (const doc of allDocuments) {
      titleToId.set(doc.title.toLowerCase().trim(), doc.id);
    }
    for (const title of linkedTitles) {
      const id = titleToId.get(title);
      if (id) ids.add(id);
    }
  }

  // Also extract from pageLink inline content nodes
  const pageLinkIds = extractPageLinkIds(content);
  for (const id of pageLinkIds) {
    ids.add(id);
  }

  return Array.from(ids);
}

/** Sync backlinks for a source document. Replaces all existing outgoing links. */
export async function syncBacklinks(
  sourceDocId: string,
  targetDocIds: string[]
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const links = getLocalBacklinks().filter(
      (l) => l.source_document_id !== sourceDocId
    );
    const now = new Date().toISOString();
    for (const targetId of targetDocIds) {
      if (targetId !== sourceDocId) {
        links.push({
          id: uuidv4(),
          source_document_id: sourceDocId,
          target_document_id: targetId,
          created_at: now,
        });
      }
    }
    setLocalBacklinks(links);
    return;
  }

  // Delete existing outgoing links
  await supabase!
    .from("backlinks")
    .delete()
    .eq("source_document_id", sourceDocId);

  // Insert new links (user_id defaults to auth.uid() via RLS default)
  if (targetDocIds.length > 0) {
    const userId = await getCurrentUserId();
    const rows = targetDocIds
      .filter((tid) => tid !== sourceDocId)
      .map((tid) => ({
        source_document_id: sourceDocId,
        target_document_id: tid,
        user_id: userId,
      }));
    if (rows.length > 0) {
      const { error } = await supabase!.from("backlinks").insert(rows);
      if (error) throw error;
    }
  }
}

/** Get backlinks pointing TO a document (incoming links) */
export async function getBacklinksForDocument(
  documentId: string
): Promise<Backlink[]> {
  if (!isSupabaseConfigured()) {
    const links = getLocalBacklinks().filter(
      (l) => l.target_document_id === documentId
    );
    const docs = getLocalDocuments();
    const docMap = new Map(docs.map((d) => [d.id, d.title]));
    return links
      .map((l) => ({
        documentId: l.source_document_id,
        documentTitle: docMap.get(l.source_document_id) || "Unknown",
      }))
      .filter((b) => b.documentTitle !== "Unknown");
  }

  // Join with documents to get titles
  const { data, error } = await supabase!
    .from("backlinks")
    .select("source_document_id, documents!backlinks_source_document_id_fkey(title)")
    .eq("target_document_id", documentId);

  if (error) {
    // Fallback: fetch separately if join fails
    const { data: linkData, error: linkErr } = await supabase!
      .from("backlinks")
      .select("source_document_id")
      .eq("target_document_id", documentId);

    if (linkErr) throw linkErr;
    if (!linkData || linkData.length === 0) return [];

    const sourceIds = linkData.map((l: { source_document_id: string }) => l.source_document_id);
    const { data: docData, error: docErr } = await supabase!
      .from("documents")
      .select("id, title")
      .in("id", sourceIds);

    if (docErr) throw docErr;
    return (docData ?? []).map((d: { id: string; title: string }) => ({
      documentId: d.id,
      documentTitle: d.title,
    }));
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const doc = row.documents as { title: string } | null;
    return {
      documentId: row.source_document_id as string,
      documentTitle: doc?.title || "Unknown",
    };
  });
}

/** Get outgoing links FROM a document */
export async function getOutgoingLinks(
  documentId: string
): Promise<Backlink[]> {
  if (!isSupabaseConfigured()) {
    const links = getLocalBacklinks().filter(
      (l) => l.source_document_id === documentId
    );
    const docs = getLocalDocuments();
    const docMap = new Map(docs.map((d) => [d.id, d.title]));
    return links
      .map((l) => ({
        documentId: l.target_document_id,
        documentTitle: docMap.get(l.target_document_id) || "Unknown",
      }))
      .filter((b) => b.documentTitle !== "Unknown");
  }

  const { data: linkData, error: linkErr } = await supabase!
    .from("backlinks")
    .select("target_document_id")
    .eq("source_document_id", documentId);

  if (linkErr) throw linkErr;
  if (!linkData || linkData.length === 0) return [];

  const targetIds = linkData.map((l: { target_document_id: string }) => l.target_document_id);
  const { data: docData, error: docErr } = await supabase!
    .from("documents")
    .select("id, title")
    .in("id", targetIds);

  if (docErr) throw docErr;
  return (docData ?? []).map((d: { id: string; title: string }) => ({
    documentId: d.id,
    documentTitle: d.title,
  }));
}

/** All backlink edges for the current user. RLS scopes the query. */
export async function listAllBacklinks(): Promise<{ source: string; target: string }[]> {
  if (!isSupabaseConfigured()) {
    return getLocalBacklinks().map((l) => ({
      source: l.source_document_id,
      target: l.target_document_id,
    }));
  }

  const { data, error } = await supabase!
    .from("backlinks")
    .select("source_document_id, target_document_id");

  if (error) throw error;
  return (data ?? []).map((row: { source_document_id: string; target_document_id: string }) => ({
    source: row.source_document_id,
    target: row.target_document_id,
  }));
}

/** Load persisted graph node positions from the database. */
export async function getGraphLayout(): Promise<GraphLayout | null> {
  if (!isSupabaseConfigured()) return null;

  const userId = await getCurrentUserId();
  if (userId === "local") return null;

  const { data, error } = await supabase!
    .from("graph_layouts")
    .select("topology_hash, positions")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[graph] failed to load layout", error);
    return null;
  }
  if (!data) return null;
  const positions = (data.positions ?? {}) as Record<string, [number, number]>;
  return { topologyHash: data.topology_hash as string, positions };
}

/** Persist graph positions to the database. Instant cache is handled by the caller. */
export async function saveGraphLayout(layout: GraphLayout): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const userId = await getCurrentUserId();
  if (userId === "local") return;

  const { error } = await supabase!.from("graph_layouts").upsert(
    {
      user_id: userId,
      topology_hash: layout.topologyHash,
      positions: layout.positions,
    },
    { onConflict: "user_id" }
  );
  if (error) console.warn("[graph] failed to save layout", error);
}

/** Re-parse every document and replace the backlinks table. Returns edge count. */
export async function rebuildAllBacklinks(allDocuments: DbDocument[]): Promise<number> {
  let docsWithContent: Pick<DbDocument, "id" | "title" | "content">[] = [];

  if (!isSupabaseConfigured()) {
    docsWithContent = getLocalDocuments();
  } else {
    const { data, error } = await supabase!
      .from("documents")
      .select("id, title, content");
    if (error) throw error;
    docsWithContent = (data ?? []) as Pick<DbDocument, "id" | "title" | "content">[];
  }

  const titleIndex = allDocuments.length > 0 ? allDocuments : (docsWithContent as DbDocument[]);
  const links: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const doc of docsWithContent) {
    const targets = parseBacklinks(doc.content, titleIndex);
    for (const target of targets) {
      if (target === doc.id) continue;
      const key = `${doc.id}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: doc.id, target });
    }
  }

  if (!isSupabaseConfigured()) {
    const now = new Date().toISOString();
    setLocalBacklinks(
      links.map((l) => ({
        id: uuidv4(),
        source_document_id: l.source,
        target_document_id: l.target,
        created_at: now,
      }))
    );
    return links.length;
  }

  const userId = await getCurrentUserId();
  await supabase!.from("backlinks").delete().eq("user_id", userId);

  const CHUNK = 500;
  for (let i = 0; i < links.length; i += CHUNK) {
    const rows = links.slice(i, i + CHUNK).map((l) => ({
      source_document_id: l.source,
      target_document_id: l.target,
      user_id: userId,
    }));
    const { error } = await supabase!.from("backlinks").insert(rows);
    if (error) throw error;
  }
  return links.length;
}

// ============================================================
// Attachment Operations (Google Drive–backed files)
// ============================================================

const ATTACHMENTS_KEY = "cortex_attachments";

function getLocalAttachments(): DbAttachment[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(ATTACHMENTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalAttachments(attachments: DbAttachment[]) {
  localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachments));
}

function dbAttachmentToAttachment(a: DbAttachment): Attachment {
  return {
    id: a.id,
    documentId: a.document_id,
    fileName: a.file_name,
    mimeType: a.mime_type,
    fileSize: a.file_size,
    driveFileId: a.drive_file_id,
    driveWebViewLink: a.drive_web_view_link,
    createdAt: a.created_at,
  };
}

export async function fetchAttachments(documentId: string): Promise<Attachment[]> {
  if (!isSupabaseConfigured()) {
    return getLocalAttachments()
      .filter((a) => a.document_id === documentId)
      .map(dbAttachmentToAttachment);
  }

  const { data, error } = await supabase!
    .from("attachments")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(dbAttachmentToAttachment);
}

export async function createAttachment(opts: {
  documentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  driveFileId: string;
  driveWebViewLink: string | null;
}): Promise<Attachment> {
  const userId = await getCurrentUserId();

  if (!isSupabaseConfigured()) {
    const att: DbAttachment = {
      id: uuidv4(),
      document_id: opts.documentId,
      user_id: userId,
      file_name: opts.fileName,
      mime_type: opts.mimeType,
      file_size: opts.fileSize,
      drive_file_id: opts.driveFileId,
      drive_web_view_link: opts.driveWebViewLink,
      created_at: new Date().toISOString(),
    };
    setLocalAttachments([...getLocalAttachments(), att]);
    return dbAttachmentToAttachment(att);
  }

  const { data, error } = await supabase!
    .from("attachments")
    .insert({
      document_id: opts.documentId,
      user_id: userId,
      file_name: opts.fileName,
      mime_type: opts.mimeType,
      file_size: opts.fileSize,
      drive_file_id: opts.driveFileId,
      drive_web_view_link: opts.driveWebViewLink,
    })
    .select()
    .single();

  if (error) throw error;
  return dbAttachmentToAttachment(data);
}

export async function deleteAttachment(id: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    setLocalAttachments(getLocalAttachments().filter((a) => a.id !== id));
    return;
  }

  const { error } = await supabase!.from("attachments").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// PDF Annotations (highlights, notes, chats on Drive PDFs)
// ============================================================

const PDF_ANNOTATIONS_KEY = "cortex_pdf_annotations";

function getLocalPdfAnnotations(): DbPdfAnnotation[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(PDF_ANNOTATIONS_KEY) || "[]");
  } catch {
    return [];
  }
}

function setLocalPdfAnnotations(annotations: DbPdfAnnotation[]) {
  localStorage.setItem(PDF_ANNOTATIONS_KEY, JSON.stringify(annotations));
}

function dbPdfAnnotationToClient(row: DbPdfAnnotation): PdfAnnotation {
  return {
    id: row.id,
    driveFileId: row.drive_file_id,
    color: row.color,
    type: row.type,
    anchor: {
      pageNumber: row.page_number,
      exact: row.anchor_exact,
      prefix: row.anchor_prefix ?? undefined,
      suffix: row.anchor_suffix ?? undefined,
    },
    note: row.note,
    messages: row.messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function fetchPdfAnnotations(driveFileId: string): Promise<PdfAnnotation[]> {
  if (!isSupabaseConfigured()) {
    return getLocalPdfAnnotations()
      .filter((a) => a.drive_file_id === driveFileId)
      .map(dbPdfAnnotationToClient);
  }

  const { data, error } = await supabase!
    .from("pdf_annotations")
    .select("*")
    .eq("drive_file_id", driveFileId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => {
    const messages = parseJsonField<AnnotationMessage[]>(row.messages, []);
    return dbPdfAnnotationToClient({ ...row, messages } as DbPdfAnnotation);
  });
}

export async function createPdfAnnotation(opts: {
  driveFileId: string;
  color: PdfAnnotationColor;
  type: PdfAnnotationType;
  anchor: TextAnchor;
  note?: string | null;
}): Promise<PdfAnnotation> {
  const now = new Date().toISOString();
  const userId = await getCurrentUserId();
  const row: DbPdfAnnotation = {
    id: uuidv4(),
    drive_file_id: opts.driveFileId,
    user_id: userId,
    color: opts.color,
    type: opts.type,
    page_number: opts.anchor.pageNumber,
    anchor_exact: opts.anchor.exact,
    anchor_prefix: opts.anchor.prefix ?? null,
    anchor_suffix: opts.anchor.suffix ?? null,
    note: opts.note ?? null,
    messages: [],
    created_at: now,
    updated_at: now,
  };

  if (!isSupabaseConfigured()) {
    const all = getLocalPdfAnnotations();
    all.push(row);
    setLocalPdfAnnotations(all);
    return dbPdfAnnotationToClient(row);
  }

  const { data, error } = await supabase!
    .from("pdf_annotations")
    .insert({
      id: row.id,
      drive_file_id: row.drive_file_id,
      user_id: row.user_id,
      color: row.color,
      type: row.type,
      page_number: row.page_number,
      anchor_exact: row.anchor_exact,
      anchor_prefix: row.anchor_prefix,
      anchor_suffix: row.anchor_suffix,
      note: row.note,
      messages: row.messages,
    })
    .select()
    .single();

  if (error) throw error;
  const messages = parseJsonField<AnnotationMessage[]>(
    (data as { messages?: unknown }).messages,
    []
  );
  return dbPdfAnnotationToClient({ ...data, messages } as DbPdfAnnotation);
}

export async function updatePdfAnnotation(
  id: string,
  updates: Partial<{ color: PdfAnnotationColor; type: PdfAnnotationType; note: string | null; messages: AnnotationMessage[] }>
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const all = getLocalPdfAnnotations();
    const idx = all.findIndex((a) => a.id === id);
    if (idx >= 0) {
      if (updates.color !== undefined) all[idx].color = updates.color;
      if (updates.type !== undefined) all[idx].type = updates.type;
      if (updates.note !== undefined) all[idx].note = updates.note;
      if (updates.messages !== undefined) all[idx].messages = updates.messages;
      all[idx].updated_at = new Date().toISOString();
      setLocalPdfAnnotations(all);
    }
    return;
  }

  const { error } = await supabase!
    .from("pdf_annotations")
    .update(updates)
    .eq("id", id);

  if (error) throw error;
}

export async function deletePdfAnnotation(id: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    setLocalPdfAnnotations(getLocalPdfAnnotations().filter((a) => a.id !== id));
    return;
  }

  const { error } = await supabase!.from("pdf_annotations").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// System Documents (Todo, Daily)
// ============================================================

async function fetchSystemDocByType(
  docType: import("./types").DocType
): Promise<DbDocument | null> {
  const { data, error } = await supabase!
    .from("documents")
    .select(DOCUMENT_CONTENT_COLUMNS)
    .eq("doc_type", docType)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DbDocument | null) ?? null;
}

async function createOrGetSystemDoc(
  insert: () => Promise<DbDocument>,
  reload: () => Promise<DbDocument | null>
): Promise<DbDocument> {
  try {
    return await insert();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await reload();
    if (existing) return existing;
    throw err;
  }
}

async function writeContentIfChanged(id: string, content: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    await updateDocument(id, { content });
    return;
  }
  const { data, error } = await supabase!
    .from("documents")
    .select("content")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (data?.content === content) return;
  await updateDocument(id, { content });
}

/**
 * Find or create the singleton todo document.
 * Uses doc_type = "todo" to locate it.
 */
export async function ensureTodoDocument(): Promise<DbDocument> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const existing = docs.find((d) => d.doc_type === "todo");
    if (existing) return existing;
    return createDocument(null, "Todo", "[]", null, "todo");
  }

  const existing = await fetchSystemDocByType("todo");
  if (existing) return existing;
  return createOrGetSystemDoc(
    () => createDocument(null, "Todo", "[]", null, "todo"),
    () => fetchSystemDocByType("todo")
  );
}

/**
 * Find or create the daily-documents parent note.
 * Uses doc_type = "daily_parent".
 */
export async function ensureDailyParentDocument(): Promise<DbDocument> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const existing = docs.find((d) => d.doc_type === "daily_parent");
    if (existing) return existing;
    return createDocument(null, "Daily Documents", "[]", null, "daily_parent");
  }

  const existing = await fetchSystemDocByType("daily_parent");
  if (existing) return existing;
  return createOrGetSystemDoc(
    () => createDocument(null, "Daily Documents", "[]", null, "daily_parent"),
    () => fetchSystemDocByType("daily_parent")
  );
}

/**
 * Find or create today's daily document (child of the daily-parent).
 */
export async function ensureTodayDailyDocument(): Promise<DbDocument> {
  const parent = await ensureDailyParentDocument();
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // Local, so the tag agrees with the title above. Lookups also accept the
  // legacy UTC tag — see src/lib/dateTag.ts.
  const dateTag = localDateTag(today);
  const lookupTags = dateTagsForLookup(today);

  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const existing = docs.find(
      (d) => d.doc_type === "daily" && d.tags.some((t) => lookupTags.includes(t))
    );
    if (existing) return existing;

    const placeholderContent = JSON.stringify([
      {
        id: uuidv4(),
        type: "heading",
        props: { level: 2, textColor: "default", backgroundColor: "default", textAlignment: "left" },
        content: [{ type: "text", text: dateStr, styles: {} }],
        children: [],
      },
      {
        id: uuidv4(),
        type: "paragraph",
        props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
        content: [{ type: "text", text: "Today's daily note. AI-generated content coming soon.", styles: {} }],
        children: [],
      },
    ]);

    const newDoc = await createDocument(null, dateStr, placeholderContent, parent.id, "daily", [dateTag]);
    await syncDailyParentDatabase(parent.id);
    return newDoc;
  }

  // Supabase path
  const loadTodayDaily = async (): Promise<DbDocument | null> => {
    const { data: dailyMatches, error } = await supabase!
      .from("documents")
      .select(DOCUMENT_CONTENT_COLUMNS)
      .eq("doc_type", "daily")
      .overlaps("tags", lookupTags);
    if (error) throw error;
    return (
      (dailyMatches?.find((d) => d.tags?.includes(dateTag)) as DbDocument | undefined) ??
      (dailyMatches?.[0] as DbDocument | undefined) ??
      null
    );
  };

  const daily = await loadTodayDaily();
  if (daily) return daily;

  const placeholderContent = JSON.stringify([
    {
      id: uuidv4(),
      type: "heading",
      props: { level: 2, textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: dateStr, styles: {} }],
      children: [],
    },
    {
      id: uuidv4(),
      type: "paragraph",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "Today's daily note. AI-generated content coming soon.", styles: {} }],
      children: [],
    },
  ]);

  return createOrGetSystemDoc(
    async () => {
      const doc = await createDocument(
        null,
        dateStr,
        placeholderContent,
        parent.id,
        "daily",
        [dateTag]
      );
      await syncDailyParentDatabase(parent.id);
      return doc;
    },
    loadTodayDaily
  );
}

// ── Daily Parent database helpers ───────────────────────────

const DAILY_COL_TITLE = "daily-title";
const DAILY_COL_DATE = "daily-date";

function buildDailyParentDatabaseContent(
  dailyDocs: { id: string; title: string; dateTag: string }[]
): string {
  const columns = JSON.stringify([
    { id: DAILY_COL_TITLE, name: "Day", type: "text", width: 350, isTitle: true },
    { id: DAILY_COL_DATE, name: "Date", type: "date", width: 160 },
  ]);
  const rows = JSON.stringify(
    dailyDocs.map((d) => ({
      id: d.id,
      docId: d.id,
      cells: {
        [DAILY_COL_TITLE]: d.title,
        [DAILY_COL_DATE]: d.dateTag,
      },
    }))
  );
  return JSON.stringify([
    {
      id: "daily-parent-db-block",
      type: "database",
      props: { columns, rows },
      content: undefined,
      children: [],
    },
  ]);
}

/**
 * Rebuild the database block in the Daily Documents parent
 * so it lists all daily documents.
 */
export async function syncDailyParentDatabase(parentId: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const dailyDocs = docs
      .filter((d) => d.parent_document_id === parentId && d.doc_type === "daily")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((d) => ({
        id: d.id,
        title: d.title,
        dateTag: d.tags.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "",
      }));

    const content = buildDailyParentDatabaseContent(dailyDocs);
    const idx = docs.findIndex((d) => d.id === parentId);
    if (idx >= 0) {
      docs[idx].content = content;
      docs[idx].updated_at = new Date().toISOString();
      setLocalDocuments(docs);
    }
    return;
  }

  // Supabase path
  const dailyDocs = await fetchAllPages<{
    id: string;
    title: string;
    tags: string[];
    created_at: string;
  }>((from, to) =>
    supabase!
      .from("documents")
      .select("id, title, tags, created_at")
      .eq("parent_document_id", parentId)
      .eq("doc_type", "daily")
      .order("created_at", { ascending: false })
      .range(from, to)
  );

  const items = dailyDocs.map((d) => ({
    id: d.id,
    title: d.title,
    dateTag: d.tags.find((t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "",
  }));

  await writeContentIfChanged(parentId, buildDailyParentDatabaseContent(items));
}

// ============================================================
// Quick Notes
// ============================================================

// ── Quick Notes database helpers ────────────────────────────

/** Stable column IDs used across all quick note databases */
const QN_PARENT_COL_TITLE = "qn-parent-title";
const QN_PARENT_COL_DATE = "qn-parent-date";
const QN_DAY_COL_TITLE = "qn-day-title";

function buildParentDatabaseContent(
  allNotes: { id: string; title: string; dateTag: string }[]
): string {
  const columns = JSON.stringify([
    { id: QN_PARENT_COL_TITLE, name: "Title", type: "text", width: 350, isTitle: true },
    { id: QN_PARENT_COL_DATE, name: "Date", type: "date", width: 160 },
  ]);
  const rows = JSON.stringify(
    allNotes.map((n) => ({
      id: n.id,
      docId: n.id,
      cells: {
        [QN_PARENT_COL_TITLE]: n.title,
        [QN_PARENT_COL_DATE]: n.dateTag,
      },
    }))
  );
  return JSON.stringify([
    {
      id: "qn-parent-db-block",
      type: "database",
      props: { columns, rows },
      content: undefined,
      children: [],
    },
  ]);
}

function buildDayDatabaseContent(
  quickNotes: { id: string; title: string }[]
): string {
  const columns = JSON.stringify([
    { id: QN_DAY_COL_TITLE, name: "Title", type: "text", width: 400, isTitle: true },
  ]);
  const rows = JSON.stringify(
    quickNotes.map((n) => ({
      id: n.id,
      docId: n.id,
      cells: {
        [QN_DAY_COL_TITLE]: n.title,
      },
    }))
  );
  return JSON.stringify([
    {
      id: "qn-day-db-block",
      type: "database",
      props: { columns, rows },
      content: undefined,
      children: [],
    },
  ]);
}

/**
 * Rebuild the database blocks in the Quick Notes parent and the given day container
 * so they reflect the actual document tree.
 */
export async function syncQuickNoteDatabases(
  parentId: string,
  dayContainerId?: string
): Promise<void> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();

    // Collect all day containers (children of parent that are tagged with a date)
    const dayContainers = docs
      .filter((d) => d.parent_document_id === parentId && d.doc_type === "note")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    // Collect ALL individual quick notes across all day containers for the parent DB
    const allNotes: { id: string; title: string; dateTag: string }[] = [];
    for (const dc of dayContainers) {
      const dateTag = dc.tags.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "";
      const children = docs
        .filter((d) => d.parent_document_id === dc.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const child of children) {
        allNotes.push({ id: child.id, title: child.title, dateTag });
      }
    }

    // Update parent database with all individual notes
    const parentContent = buildParentDatabaseContent(allNotes);
    const parentIdx = docs.findIndex((d) => d.id === parentId);
    if (parentIdx >= 0) {
      docs[parentIdx].content = parentContent;
      docs[parentIdx].updated_at = new Date().toISOString();
    }

    // Update day container databases
    const containersToSync = dayContainerId
      ? dayContainers.filter((c) => c.id === dayContainerId)
      : dayContainers;

    for (const container of containersToSync) {
      const children = docs
        .filter((d) => d.parent_document_id === container.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((d) => ({ id: d.id, title: d.title }));
      const dayContent = buildDayDatabaseContent(children);
      const dayIdx = docs.findIndex((d) => d.id === container.id);
      if (dayIdx >= 0) {
        docs[dayIdx].content = dayContent;
        docs[dayIdx].updated_at = new Date().toISOString();
      }
    }

    setLocalDocuments(docs);
    return;
  }

  // Supabase path — collect day containers, then all their children in one query
  const { data: dayDocs, error: dayErr } = await supabase!
    .from("documents")
    .select("id, title, tags, created_at")
    .eq("parent_document_id", parentId)
    .eq("doc_type", "note")
    .order("created_at", { ascending: false });
  if (dayErr) throw dayErr;

  const dayContainers = (dayDocs ?? []).map(
    (d: { id: string; title: string; tags: string[]; created_at: string }) => ({
      id: d.id,
      title: d.title,
      dateTag: d.tags.find((t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "",
    })
  );

  if (dayContainers.length === 0) {
    await writeContentIfChanged(parentId, buildParentDatabaseContent([]));
    return;
  }

  const children = await fetchAllPages<{
    id: string;
    title: string;
    parent_document_id: string | null;
    created_at: string;
  }>((from, to) =>
    supabase!
      .from("documents")
      .select("id, title, parent_document_id, created_at")
      .in(
        "parent_document_id",
        dayContainers.map((c) => c.id)
      )
      .order("created_at", { ascending: false })
      .range(from, to)
  );

  const childrenByParent = new Map<string, { id: string; title: string }[]>();
  for (const child of children) {
    if (!child.parent_document_id) continue;
    const list = childrenByParent.get(child.parent_document_id) ?? [];
    list.push({ id: child.id, title: child.title });
    childrenByParent.set(child.parent_document_id, list);
  }

  const allNotes: { id: string; title: string; dateTag: string }[] = [];
  for (const dc of dayContainers) {
    for (const child of childrenByParent.get(dc.id) ?? []) {
      allNotes.push({ id: child.id, title: child.title, dateTag: dc.dateTag });
    }
  }

  await writeContentIfChanged(parentId, buildParentDatabaseContent(allNotes));

  const containersToSync = dayContainerId
    ? dayContainers.filter((c) => c.id === dayContainerId)
    : dayContainers;

  for (const container of containersToSync) {
    await writeContentIfChanged(
      container.id,
      buildDayDatabaseContent(childrenByParent.get(container.id) ?? [])
    );
  }
}

/**
 * Find or create the singleton Quick Notes parent document.
 * Uses doc_type = "quick_note_parent".
 */
export async function ensureQuickNoteParentDocument(): Promise<DbDocument> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const existing = docs.find((d) => d.doc_type === "quick_note_parent");
    if (existing) return existing;

    const doc = await createDocument(
      null, "Quick Notes",
      buildParentDatabaseContent([]),
      null, "quick_note_parent"
    );
    return doc;
  }

  const existing = await fetchSystemDocByType("quick_note_parent");
  if (existing) return existing;
  return createOrGetSystemDoc(
    () =>
      createDocument(
        null,
        "Quick Notes",
        buildParentDatabaseContent([]),
        null,
        "quick_note_parent"
      ),
    () => fetchSystemDocByType("quick_note_parent")
  );
}

/**
 * Find or create today's day-container under the Quick Notes parent.
 * This is a regular note (doc_type="note") whose parent is the quick_note_parent.
 * Tagged with the date string (YYYY-MM-DD) so we can find it again.
 */
export async function ensureTodayQuickNoteContainer(): Promise<DbDocument> {
  const parent = await ensureQuickNoteParentDocument();
  const today = new Date();
  const dateTag = localDateTag(today);
  const lookupTags = dateTagsForLookup(today);
  const dateStr = dayContainerTitle(today);

  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const existing = docs.find(
      (d) =>
        d.parent_document_id === parent.id &&
        d.doc_type === "note" &&
        d.tags.some((t) => lookupTags.includes(t))
    );
    if (existing) return existing;

    const doc = await createDocument(
      null, dateStr,
      buildDayDatabaseContent([]),
      parent.id, "note",
      [dateTag]
    );
    await syncQuickNoteDatabases(parent.id);
    return doc;
  }

  const loadTodayContainer = async (): Promise<DbDocument | null> => {
    const { data: containerMatches, error } = await supabase!
      .from("documents")
      .select(DOCUMENT_CONTENT_COLUMNS)
      .eq("parent_document_id", parent.id)
      .overlaps("tags", lookupTags);
    if (error) throw error;
    return (
      (containerMatches?.find((d) => d.tags?.includes(dateTag)) as DbDocument | undefined) ??
      (containerMatches?.[0] as DbDocument | undefined) ??
      null
    );
  };

  const container = await loadTodayContainer();
  if (container) return container;

  return createOrGetSystemDoc(
    async () => {
      const doc = await createDocument(
        null,
        dateStr,
        buildDayDatabaseContent([]),
        parent.id,
        "note",
        [dateTag]
      );
      await syncQuickNoteDatabases(parent.id);
      return doc;
    },
    loadTodayContainer
  );
}

/**
 * Create a new quick note (regular note) under today's day container.
 * Also syncs the database blocks in both the day container and the parent.
 */
export async function createQuickNote(title: string): Promise<DbDocument> {
  const container = await ensureTodayQuickNoteContainer();
  const doc = await createDocument(null, title, "[]", container.id, "note");

  // Tag with "quick note"
  await updateDocument(doc.id, { tags: ["quick note"] });
  doc.tags = ["quick note"];

  // Find parent ID to sync both databases
  const parentId = container.parent_document_id;
  if (parentId) {
    await syncQuickNoteDatabases(parentId, container.id);
  }

  return doc;
}

/**
 * Fetch today's quick notes (children of today's day container).
 */
export async function fetchTodayQuickNotes(): Promise<DbDocument[]> {
  const parent = await ensureQuickNoteParentDocument();
  const today = new Date();
  const dateTag = localDateTag(today);
  const lookupTags = dateTagsForLookup(today);

  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    // Find today's container
    const container = docs.find(
      (d) =>
        d.parent_document_id === parent.id &&
        d.doc_type === "note" &&
        d.tags.some((t) => lookupTags.includes(t))
    );
    if (!container) return [];
    // Return children ordered newest first
    return docs
      .filter((d) => d.parent_document_id === container.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  const containerRows = await fetchAllPages<{ id: string; tags: string[] }>(
    (from, to) =>
      supabase!
        .from("documents")
        .select("id, tags")
        .eq("parent_document_id", parent.id)
        .overlaps("tags", lookupTags)
        .order("id", { ascending: true })
        .range(from, to)
  );

  const containerData =
    containerRows.find((d) => d.tags?.includes(dateTag)) ?? containerRows[0];
  if (!containerData) return [];

  return fetchAllPages<DbDocument>((from, to) =>
    supabase!
      .from("documents")
      .select(DOCUMENT_CONTENT_COLUMNS)
      .eq("parent_document_id", containerData.id)
      .order("created_at", { ascending: false })
      .range(from, to)
  );
}

// ============================================================
// Share Links
// ============================================================

function generateShareSlug(): string {
  // 8 char alphanumeric slug: url-friendly, ~2.8 trillion possible values
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 8; i++) {
    slug += chars[arr[i] % chars.length];
  }
  return slug;
}

/**
 * Enable or disable public sharing for a document.
 * When enabled, generates a unique slug. When disabled, clears it.
 * Returns the slug (or null if disabled).
 */
export async function toggleShareLink(
  docId: string,
  enable: boolean
): Promise<string | null> {
  const slug = enable ? generateShareSlug() : null;

  if (!isSupabaseConfigured()) {
    // Local storage fallback
    const docs = getLocalDocuments();
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx >= 0) {
      docs[idx] = { ...docs[idx], share_slug: slug, updated_at: new Date().toISOString() };
      setLocalDocuments(docs);
    }
    return slug;
  }

  const { error } = await supabase!
    .from("documents")
    .update({ share_slug: slug })
    .eq("id", docId);

  if (error) throw error;
  return slug;
}

// ============================================================
// Moodboard State Operations
// ============================================================

/** Fetch the tldraw snapshot for a moodboard document. Returns null if none saved yet. */
export async function fetchMoodboardState(
  documentId: string
): Promise<{ tldraw_snapshot: unknown; canvas_settings: unknown } | null> {
  if (!isSupabaseConfigured()) {
    // Local storage fallback
    try {
      const raw = localStorage.getItem(`cortex_moodboard_state:${documentId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const { data, error } = await supabase!
    .from("moodboard_state")
    .select("tldraw_snapshot, canvas_settings")
    .eq("document_id", documentId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Save (upsert) the tldraw snapshot for a moodboard document. */
export async function saveMoodboardState(
  documentId: string,
  tldrawSnapshot: unknown,
  canvasSettings?: unknown
): Promise<void> {
  if (!isSupabaseConfigured()) {
    // Local storage fallback
    localStorage.setItem(
      `cortex_moodboard_state:${documentId}`,
      JSON.stringify({
        tldraw_snapshot: tldrawSnapshot,
        canvas_settings: canvasSettings ?? {},
      })
    );
    return;
  }

  const { error } = await supabase!
    .from("moodboard_state")
    .upsert(
      {
        document_id: documentId,
        tldraw_snapshot: tldrawSnapshot,
        canvas_settings: canvasSettings ?? {},
      },
      { onConflict: "document_id" }
    );

  if (error) throw error;
}

/** Create an empty moodboard_state row for a new moodboard. */
export async function createMoodboardState(documentId: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    localStorage.setItem(
      `cortex_moodboard_state:${documentId}`,
      JSON.stringify({ tldraw_snapshot: null, canvas_settings: {} })
    );
    return;
  }

  const { error } = await supabase!
    .from("moodboard_state")
    .insert({ document_id: documentId });

  if (error) throw error;
}
