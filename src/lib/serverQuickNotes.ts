import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { localDateTag, dateTagsForLookup, dayContainerTitle } from "./dateTag";
import { markdownToBlockNote } from "./markdownToBlocks";

/**
 * Server-side Quick Notes hierarchy.
 *
 * WHY THIS ISN'T JUST `db.ts`
 * ---------------------------
 * `src/lib/db.ts` holds the same logic, but it runs against the *browser*
 * Supabase client and resolves the owner through `auth.uid()`. An API route has
 * neither: it uses the service-role client, which has no session at all. So this
 * mirrors the hierarchy with an explicit, already-verified `userId`.
 *
 * It deliberately does NOT copy `create_note`'s trick of reading `user_id` from
 * an arbitrary sample row. Callers pass an id verified from a bearer token.
 *
 * THE BLOCK IDS AND COLUMN IDS BELOW ARE A CONTRACT
 * -------------------------------------------------
 * The web app rebuilds these same database blocks from db.ts. If the ids drift,
 * the two sides start producing structurally different tables for the same
 * container and each rewrite fights the other. Keep them identical to the
 * constants in db.ts.
 *
 *   Quick Notes            doc_type = 'quick_note_parent'   (singleton per user)
 *     └── "Wednesday, …"   doc_type = 'note', tags = ['2026-03-18']
 *           └── "buy milk" doc_type = 'note', tags = ['quick note', …]
 */

// Must match db.ts exactly.
const QN_PARENT_COL_TITLE = "qn-parent-title";
const QN_PARENT_COL_DATE = "qn-parent-date";
const QN_DAY_COL_TITLE = "qn-day-title";
const QN_PARENT_BLOCK_ID = "qn-parent-db-block";
const QN_DAY_BLOCK_ID = "qn-day-db-block";

export const QUICK_NOTE_TAG = "quick note";

export type DocumentRow = {
  id: string;
  title: string;
  tags: string[] | null;
  content: string | null;
  doc_type: string;
  parent_document_id: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
};

// ─── Database block builders (byte-compatible with db.ts) ───

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
    { id: QN_PARENT_BLOCK_ID, type: "database", props: { columns, rows }, content: undefined, children: [] },
  ]);
}

function buildDayDatabaseContent(quickNotes: { id: string; title: string }[]): string {
  const columns = JSON.stringify([
    { id: QN_DAY_COL_TITLE, name: "Title", type: "text", width: 400, isTitle: true },
  ]);
  const rows = JSON.stringify(
    quickNotes.map((n) => ({
      id: n.id,
      docId: n.id,
      cells: { [QN_DAY_COL_TITLE]: n.title },
    }))
  );
  return JSON.stringify([
    { id: QN_DAY_BLOCK_ID, type: "database", props: { columns, rows }, content: undefined, children: [] },
  ]);
}

// ─── Hierarchy ───

async function insertDocument(
  admin: SupabaseClient,
  userId: string,
  fields: {
    id?: string;
    title: string;
    content: string;
    parentDocumentId: string | null;
    docType: string;
    tags?: string[];
  }
): Promise<DocumentRow> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("documents")
    .insert({
      id: fields.id ?? randomUUID(),
      title: fields.title,
      subtitle: null,
      folder_id: null,
      parent_document_id: fields.parentDocumentId,
      user_id: userId,
      content: fields.content,
      tags: fields.tags ?? [],
      settings: {},
      doc_type: fields.docType,
      position: 0,
      share_slug: null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as DocumentRow;
}

/** Find or create the per-user singleton Quick Notes parent. */
export async function ensureQuickNoteParent(
  admin: SupabaseClient,
  userId: string
): Promise<DocumentRow> {
  const { data, error } = await admin
    .from("documents")
    .select("*")
    .eq("doc_type", "quick_note_parent")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (data) return data as DocumentRow;

  return insertDocument(admin, userId, {
    title: "Quick Notes",
    content: buildParentDatabaseContent([]),
    parentDocumentId: null,
    docType: "quick_note_parent",
  });
}

/**
 * Find or create today's day container.
 *
 * Lookup accepts both the local and the legacy UTC date tag (see dateTag.ts);
 * creation always uses the local one, so it agrees with the container's title.
 */
export async function ensureTodayContainer(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<DocumentRow> {
  const parent = await ensureQuickNoteParent(admin, userId);
  const dateTag = localDateTag(now);
  const lookupTags = dateTagsForLookup(now);

  const { data: matches, error } = await admin
    .from("documents")
    .select("*")
    .eq("parent_document_id", parent.id)
    .eq("user_id", userId)
    .overlaps("tags", lookupTags);

  if (error) throw error;

  const existing =
    matches?.find((d: DocumentRow) => d.tags?.includes(dateTag)) ?? matches?.[0];
  if (existing) return existing as DocumentRow;

  const container = await insertDocument(admin, userId, {
    title: dayContainerTitle(now),
    content: buildDayDatabaseContent([]),
    parentDocumentId: parent.id,
    docType: "note",
    tags: [dateTag],
  });

  await syncQuickNoteDatabases(admin, userId, parent.id);
  return container;
}

/**
 * Rebuild the database blocks in the Quick Notes parent and (optionally) one day
 * container so their tables list the current children.
 *
 * This is the step that makes an iOS capture visible in the web app's table
 * views. Inserting a row alone puts the note in the sidebar tree — that is
 * derived from `parent_document_id` — but leaves both tables stale.
 */
export async function syncQuickNoteDatabases(
  admin: SupabaseClient,
  userId: string,
  parentId: string,
  dayContainerId?: string
): Promise<void> {
  const { data: dayDocs } = await admin
    .from("documents")
    .select("id, title, tags, created_at")
    .eq("parent_document_id", parentId)
    .eq("user_id", userId)
    .eq("doc_type", "note")
    .order("created_at", { ascending: false });

  const containers = dayDocs ?? [];
  const allNotes: { id: string; title: string; dateTag: string }[] = [];

  for (const container of containers) {
    const tags: string[] = container.tags ?? [];
    const dateTag = tags.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "";

    const { data: children } = await admin
      .from("documents")
      .select("id, title, created_at")
      .eq("parent_document_id", container.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    for (const child of children ?? []) {
      allNotes.push({ id: child.id, title: child.title, dateTag });
    }

    const shouldSyncThisDay = !dayContainerId || dayContainerId === container.id;
    if (shouldSyncThisDay) {
      await admin
        .from("documents")
        .update({
          content: buildDayDatabaseContent(
            (children ?? []).map((c: { id: string; title: string }) => ({ id: c.id, title: c.title }))
          ),
          updated_at: new Date().toISOString(),
        })
        .eq("id", container.id);
    }
  }

  await admin
    .from("documents")
    .update({
      content: buildParentDatabaseContent(allNotes),
      updated_at: new Date().toISOString(),
    })
    .eq("id", parentId);
}

// ─── Capture ───

export type CreateQuickNoteInput = {
  /**
   * Client-supplied primary key. trac3 passes its local `Note.id` so the local
   * and remote ids are the same uuid — which makes retries from its offline
   * outbox idempotent instead of duplicating notes.
   */
  id?: string;
  /** The idea. Becomes `title`, matching the web capture box's convention. */
  text: string;
  /** Optional body. Converted to BlockNote blocks; omitted leaves `content` "[]". */
  markdown?: string;
  /** Extra tags, e.g. trac3's classifier tags. `"quick note"` is always added. */
  tags?: string[];
};

export type CreateQuickNoteResult = {
  document: DocumentRow;
  /** False when an existing row with the same id was returned instead. */
  created: boolean;
};

/**
 * Create one quick note under today's container and resync the tables.
 *
 * The title carries the idea and the body is usually empty — that is the
 * existing web UX (`createQuickNote` writes `"[]"`), and matching it means iOS
 * captures and web captures render identically.
 */
export async function createQuickNote(
  admin: SupabaseClient,
  userId: string,
  input: CreateQuickNoteInput
): Promise<CreateQuickNoteResult> {
  const title = input.text.trim();
  if (!title) throw new Error("Quick note text is empty");

  // Idempotency: a retried outbox item must not create a second note.
  if (input.id) {
    const { data: existing } = await admin
      .from("documents")
      .select("*")
      .eq("id", input.id)
      .maybeSingle();
    if (existing) {
      if (existing.user_id !== userId) {
        throw new Error("That document id belongs to another user");
      }
      return { document: existing as DocumentRow, created: false };
    }
  }

  const container = await ensureTodayContainer(admin, userId);

  const content =
    input.markdown && input.markdown.trim()
      ? JSON.stringify(markdownToBlockNote(input.markdown))
      : "[]";

  const tags = Array.from(new Set([QUICK_NOTE_TAG, ...(input.tags ?? [])])).filter(Boolean);

  const document = await insertDocument(admin, userId, {
    id: input.id,
    title,
    content,
    parentDocumentId: container.id,
    docType: "note",
    tags,
  });

  if (container.parent_document_id) {
    await syncQuickNoteDatabases(admin, userId, container.parent_document_id, container.id);
  }

  return { document, created: true };
}
