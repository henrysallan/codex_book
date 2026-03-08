import { supabase, isSupabaseConfigured } from "./supabase";
import { DbDocument, DbFolder, Document, DocumentMeta, Folder, SearchResult, Backlink, DbBacklink } from "./types";
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

// ============================================================
// Folder Operations
// ============================================================

export async function fetchFolders(): Promise<DbFolder[]> {
  if (!isSupabaseConfigured()) return getLocalFolders();

  const { data, error } = await supabase!
    .from("folders")
    .select("*")
    .order("position", { ascending: true });

  if (error) throw error;
  return data ?? [];
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
  if (!isSupabaseConfigured()) {
    const folders = getLocalFolders().filter((f) => f.id !== id && f.parent_id !== id);
    setLocalFolders(folders);
    // Also remove documents in that folder or un-assign them
    const docs = getLocalDocuments().map((d) =>
      d.folder_id === id ? { ...d, folder_id: null } : d
    );
    setLocalDocuments(docs);
    return;
  }

  const { error } = await supabase!.from("folders").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// Document Operations
// ============================================================

export async function fetchDocuments(): Promise<DbDocument[]> {
  if (!isSupabaseConfigured()) return getLocalDocuments();

  const { data, error } = await supabase!
    .from("documents")
    .select("*")
    .order("position", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function fetchDocument(id: string): Promise<DbDocument | null> {
  if (!isSupabaseConfigured()) {
    return getLocalDocuments().find((d) => d.id === id) ?? null;
  }

  const { data, error } = await supabase!
    .from("documents")
    .select("*")
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
  title: string = "Untitled"
): Promise<DbDocument> {
  const now = new Date().toISOString();
  const userId = await getCurrentUserId();
  const doc: DbDocument = {
    id: uuidv4(),
    title,
    subtitle: null,
    folder_id: folderId,
    user_id: userId,
    content: "[]",
    tags: [],
    position: 0,
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
      user_id: doc.user_id,
      content: doc.content,
      tags: doc.tags,
      position: doc.position,
    })
    .select()
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
  }>
): Promise<DbDocument> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx >= 0) {
      docs[idx] = { ...docs[idx], ...updates, updated_at: new Date().toISOString() };
      setLocalDocuments(docs);
      return docs[idx];
    }
    throw new Error("Document not found");
  }

  const { data, error } = await supabase!
    .from("documents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteDocument(id: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    const docs = getLocalDocuments().filter((d) => d.id !== id);
    setLocalDocuments(docs);
    return;
  }

  const { error } = await supabase!.from("documents").delete().eq("id", id);
  if (error) throw error;
}

/** Move a document into a folder (or to root if folderId is null) */
export async function moveDocument(
  docId: string,
  folderId: string | null
): Promise<void> {
  await updateDocument(docId, { folder_id: folderId });
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
      position: f.position,
      isExpanded: expandedFolderIds.has(f.id),
      children: [],
      documents: [],
    });
  }

  // Assign documents to folders
  for (const d of dbDocuments) {
    const meta: DocumentMeta = {
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      folderId: d.folder_id,
      tags: d.tags,
      position: d.position,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
    if (d.folder_id && folderMap.has(d.folder_id)) {
      folderMap.get(d.folder_id)!.documents.push(meta);
    }
  }

  // Build tree
  const roots: Folder[] = [];
  for (const folder of folderMap.values()) {
    if (folder.parentId && folderMap.has(folder.parentId)) {
      folderMap.get(folder.parentId)!.children.push(folder);
    } else {
      roots.push(folder);
    }
  }

  // Get root-level documents (no folder)
  const rootDocs = dbDocuments
    .filter((d) => !d.folder_id)
    .map(
      (d): DocumentMeta => ({
        id: d.id,
        title: d.title,
        subtitle: d.subtitle,
        folderId: null,
        tags: d.tags,
        position: d.position,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })
    );

  return roots;
}

export function getRootDocuments(dbDocuments: DbDocument[]): DocumentMeta[] {
  return dbDocuments
    .filter((d) => !d.folder_id)
    .map((d) => ({
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      folderId: null,
      tags: d.tags,
      position: d.position,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));
}

export function dbDocumentToDocument(db: DbDocument): Document {
  return {
    id: db.id,
    title: db.title,
    subtitle: db.subtitle,
    folderId: db.folder_id,
    tags: db.tags,
    position: db.position,
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

  // Supabase full-text search using the RPC function
  const { data, error } = await supabase!.rpc("search_documents", {
    search_query: query,
  });

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const text = extractTextFromContent((row.content as string) || "[]");
    const q = query.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    const snippetStart = Math.max(0, idx - 60);
    const snippetEnd = Math.min(text.length, idx + query.length + 60);
    const snippet = idx >= 0 ? text.slice(snippetStart, snippetEnd) : text.slice(0, 120);

    return {
      id: row.id as string,
      title: row.title as string,
      subtitle: row.subtitle as string | null,
      tags: (row.tags as string[]) || [],
      snippet,
      rank: row.rank as number,
    };
  });
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

/** Parse [[wikilinks]] from BlockNote JSON content and return matched document IDs */
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

  if (linkedTitles.size === 0) return [];

  // Resolve titles to document IDs
  const titleToId = new Map<string, string>();
  for (const doc of allDocuments) {
    titleToId.set(doc.title.toLowerCase().trim(), doc.id);
  }

  const ids: string[] = [];
  for (const title of linkedTitles) {
    const id = titleToId.get(title);
    if (id) ids.push(id);
  }
  return ids;
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
