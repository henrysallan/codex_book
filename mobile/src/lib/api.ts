import type { DbDocument, DbFolder } from "@cortex/types";

import { supabase } from "./supabase";

// Mirrors the column sets in the web app's src/lib/db.ts. The tree never
// selects `content` (egress) — bodies load one note at a time.
const DOCUMENT_META_COLUMNS =
  "id, title, subtitle, folder_id, parent_document_id, user_id, tags, doc_type, position, share_slug, created_at, updated_at";
const DOCUMENT_CONTENT_COLUMNS = `${DOCUMENT_META_COLUMNS}, content, settings`;
const FOLDER_COLUMNS =
  "id, name, parent_id, parent_document_id, user_id, position, created_at, updated_at";

const PAGE_SIZE = 1000;

/** PostgREST caps a response at 1000 rows; page until a short page comes back. */
async function fetchAllPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return out;
  }
}

export type TreeData = { folders: DbFolder[]; documents: DbDocument[] };

export async function fetchTree(): Promise<TreeData> {
  const [folders, docs] = await Promise.all([
    fetchAllPages<DbFolder>((from, to) =>
      supabase
        .from("folders")
        .select(FOLDER_COLUMNS)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<Omit<DbDocument, "content" | "settings">>((from, to) =>
      supabase
        .from("documents")
        .select(DOCUMENT_META_COLUMNS)
        .order("id")
        .range(from, to),
    ),
  ]);
  return {
    folders,
    documents: docs.map((d) => ({ ...d, content: "[]", settings: {} })),
  };
}

export async function fetchDocument(id: string): Promise<DbDocument | null> {
  const { data, error } = await supabase
    .from("documents")
    .select(DOCUMENT_CONTENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as DbDocument | null;
}

/** The row changed since `expectedUpdatedAt` — someone else saved first. */
export class StaleWriteError extends Error {
  constructor(public current: DbDocument) {
    super("Note was changed on another device");
    this.name = "StaleWriteError";
  }
}

/**
 * Whole-body save, guarded the same way as the web editor: the update only
 * matches while `updated_at` is still what this client last loaded, so a phone
 * holding a stale copy can never silently overwrite a newer desktop edit.
 * Returns the saved row (its `updated_at` is the next expected value).
 */
export async function saveDocumentContent(
  id: string,
  content: string,
  expectedUpdatedAt: string,
): Promise<DbDocument> {
  const { data, error } = await supabase
    .from("documents")
    // `stale` tells the indexer the stored summary/embeddings are out of date.
    .update({ content, index_status: "stale" })
    .eq("id", id)
    .eq("updated_at", expectedUpdatedAt)
    .select(DOCUMENT_CONTENT_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as DbDocument;

  const current = await fetchDocument(id);
  if (current) throw new StaleWriteError(current);
  throw new Error("Note no longer exists");
}

const apiBase = (process.env.EXPO_PUBLIC_CORTEX_API_URL ?? "").replace(
  /\/$/,
  "",
);

/**
 * Ask the web app to re-chunk/summarize/embed a note so AI search sees the
 * edit. Nothing indexes server-side on write; without this, mobile edits stay
 * invisible to semantic retrieval. Best effort.
 */
export async function requestIndex(documentId: string): Promise<void> {
  if (!apiBase) return;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return;
  try {
    await fetch(`${apiBase}/api/ai/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ documentId }),
    });
  } catch (err) {
    console.warn("[index] request failed", err);
  }
}
