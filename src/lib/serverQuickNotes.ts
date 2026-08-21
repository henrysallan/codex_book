import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { localDateTag, dateTagsForLookup, dayContainerTitle, isDateTag, titleFromDateTag } from "./dateTag";
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

const DOCUMENT_ROW_COLUMNS =
  "id, title, tags, content, doc_type, parent_document_id, user_id, created_at, updated_at";

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
    /** Explicit creation time, for backfilled notes. Defaults to now. */
    createdAt?: Date;
  }
): Promise<DocumentRow> {
  const now = (fields.createdAt ?? new Date()).toISOString();
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
    .select(DOCUMENT_ROW_COLUMNS)
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
    .select(DOCUMENT_ROW_COLUMNS)
    .eq("doc_type", "quick_note_parent")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (data) return data as DocumentRow;

  try {
    return await insertDocument(admin, userId, {
      title: "Quick Notes",
      content: buildParentDatabaseContent([]),
      parentDocumentId: null,
      docType: "quick_note_parent",
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "23505") throw err;
    const { data: again, error: againErr } = await admin
      .from("documents")
      .select(DOCUMENT_ROW_COLUMNS)
      .eq("doc_type", "quick_note_parent")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (againErr) throw againErr;
    if (again) return again as DocumentRow;
    throw err;
  }
}

/**
 * Find or create the day container for `now` — today by default.
 *
 * Lookup accepts both the local and the legacy UTC date tag (see dateTag.ts);
 * creation always uses the local one, so it agrees with the container's title.
 *
 * Taking a date rather than assuming today is what makes backfill correct: a
 * note captured three weeks ago on the phone belongs in that day's container,
 * not in today's. Without it, importing an existing device history dumps
 * everything into one bucket with the wrong dates.
 *
 * `dateTagOverride` is the phone's civil date (`YYYY-MM-DD`). Vercel is UTC, so
 * `localDateTag(capturedAt)` here is the UTC date and disagrees with the device
 * in the evening in the US. When the client sends the tag, use it for both
 * lookup and the new container's title.
 */
export async function ensureContainer(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date(),
  dateTagOverride?: string,
  options?: { sync?: boolean }
): Promise<DocumentRow> {
  const parent = await ensureQuickNoteParent(admin, userId);
  const hasOverride = typeof dateTagOverride === "string" && isDateTag(dateTagOverride);
  const dateTag = hasOverride ? dateTagOverride : localDateTag(now);
  const lookupTags = hasOverride ? [dateTag] : dateTagsForLookup(now);

  const { data: matches, error } = await admin
    .from("documents")
    .select(DOCUMENT_ROW_COLUMNS)
    .eq("parent_document_id", parent.id)
    .eq("user_id", userId)
    .overlaps("tags", lookupTags);

  if (error) throw error;

  const existing =
    matches?.find((d: DocumentRow) => d.tags?.includes(dateTag)) ?? matches?.[0];
  if (existing) return existing as DocumentRow;

  try {
    const container = await insertDocument(admin, userId, {
      title: hasOverride ? titleFromDateTag(dateTag) : dayContainerTitle(now),
      content: buildDayDatabaseContent([]),
      parentDocumentId: parent.id,
      docType: "note",
      tags: [dateTag],
      createdAt: now,
    });

    if (options?.sync !== false) {
      await syncQuickNoteDatabases(admin, userId, parent.id);
    }
    return container;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "23505") throw err;
    const { data: again, error: againErr } = await admin
      .from("documents")
      .select(DOCUMENT_ROW_COLUMNS)
      .eq("parent_document_id", parent.id)
      .eq("user_id", userId)
      .overlaps("tags", lookupTags);
    if (againErr) throw againErr;
    const recovered =
      again?.find((d: DocumentRow) => d.tags?.includes(dateTag)) ?? again?.[0];
    if (recovered) return recovered as DocumentRow;
    throw err;
  }
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
  const { data: dayDocs, error: dayErr } = await admin
    .from("documents")
    .select("id, title, tags, created_at")
    .eq("parent_document_id", parentId)
    .eq("user_id", userId)
    .eq("doc_type", "note")
    .order("created_at", { ascending: false });
  if (dayErr) throw dayErr;

  const containers = dayDocs ?? [];
  const allNotes: { id: string; title: string; dateTag: string }[] = [];
  const childrenByParent = new Map<string, { id: string; title: string }[]>();

  if (containers.length > 0) {
    const { data: children, error: childErr } = await admin
      .from("documents")
      .select("id, title, parent_document_id, created_at")
      .eq("user_id", userId)
      .in(
        "parent_document_id",
        containers.map((c: { id: string }) => c.id)
      )
      .order("created_at", { ascending: false });
    if (childErr) throw childErr;

    for (const child of children ?? []) {
      const pid = child.parent_document_id as string | null;
      if (!pid) continue;
      const list = childrenByParent.get(pid) ?? [];
      list.push({ id: child.id, title: child.title });
      childrenByParent.set(pid, list);
    }
  }

  for (const container of containers) {
    const tags: string[] = container.tags ?? [];
    const dateTag = tags.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? "";
    for (const child of childrenByParent.get(container.id) ?? []) {
      allNotes.push({ id: child.id, title: child.title, dateTag });
    }
  }

  const parentContent = buildParentDatabaseContent(allNotes);
  const { data: parentRow } = await admin
    .from("documents")
    .select("content")
    .eq("id", parentId)
    .maybeSingle();
  if (parentRow?.content !== parentContent) {
    await admin
      .from("documents")
      .update({ content: parentContent, updated_at: new Date().toISOString() })
      .eq("id", parentId);
  }

  const toSync = dayContainerId
    ? containers.filter((c: { id: string }) => c.id === dayContainerId)
    : containers;

  for (const container of toSync) {
    const dayContent = buildDayDatabaseContent(
      childrenByParent.get(container.id) ?? []
    );
    const { data: dayRow } = await admin
      .from("documents")
      .select("content")
      .eq("id", container.id)
      .maybeSingle();
    if (dayRow?.content === dayContent) continue;
    await admin
      .from("documents")
      .update({
        content: dayContent,
        updated_at: new Date().toISOString(),
      })
      .eq("id", container.id);
  }
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
  /**
   * When the note was actually captured. Drives both which day container it
   * lands in and the row's `created_at`. Omit for live captures; trac3 sends it
   * for every push so backfilled history keeps its real dates.
   */
  capturedAt?: Date;
  /**
   * Device-local `YYYY-MM-DD`. Preferred over `localDateTag(capturedAt)` because
   * this code runs on Vercel (UTC) and would otherwise put evening US captures
   * in tomorrow's folder.
   */
  dateTag?: string;
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
      .select(DOCUMENT_ROW_COLUMNS)
      .eq("id", input.id)
      .maybeSingle();
    if (existing) {
      if (existing.user_id !== userId) {
        throw new Error("That document id belongs to another user");
      }
      // First backfill created the row under today and later retries no-op'd.
      // If the client now sends a capture date, move the note rather than
      // leaving it in the wrong day container.
      if (input.capturedAt || (input.dateTag && isDateTag(input.dateTag))) {
        await refileQuickNotes(admin, userId, [
          {
            id: input.id,
            capturedAt: input.capturedAt ?? new Date(existing.created_at),
            dateTag: input.dateTag,
          },
        ]);
        const { data: updated } = await admin
          .from("documents")
          .select(DOCUMENT_ROW_COLUMNS)
          .eq("id", input.id)
          .maybeSingle();
        return { document: (updated ?? existing) as DocumentRow, created: false };
      }
      return { document: existing as DocumentRow, created: false };
    }
  }

  const capturedAt = input.capturedAt ?? new Date();
  const container = await ensureContainer(admin, userId, capturedAt, input.dateTag);

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
    createdAt: capturedAt,
  });

  if (container.parent_document_id) {
    await syncQuickNoteDatabases(admin, userId, container.parent_document_id, container.id);
  }

  return { document, created: true };
}

// ─── Refile ───

export type RefileQuickNoteItem = {
  id: string;
  capturedAt: Date;
  dateTag?: string;
};

function isRefileableQuickNote(doc: DocumentRow): boolean {
  if (doc.doc_type === "quick_note_parent") return false;
  const tags = doc.tags ?? [];
  if (tags.includes(QUICK_NOTE_TAG)) return true;
  // Day containers are tagged with a single YYYY-MM-DD. Never nest those.
  if (tags.length === 1 && isDateTag(tags[0])) return false;
  return false;
}

/**
 * Move existing quick notes into the day container for their real capture date
 * and rewrite `created_at`. One parent-table rebuild at the end.
 *
 * Cortex's Date column is the day container's tag (`qn-parent-date`), not the
 * note's `created_at`. Patching timestamps alone leaves every backfilled note
 * sitting under today.
 */
export async function refileQuickNotes(
  admin: SupabaseClient,
  userId: string,
  items: RefileQuickNoteItem[]
): Promise<{ refiled: number; skipped: number }> {
  if (items.length === 0) return { refiled: 0, skipped: 0 };

  const parent = await ensureQuickNoteParent(admin, userId);
  const ids = [...new Set(items.map((item) => item.id))];
  const { data: rows, error } = await admin
    .from("documents")
    .select(DOCUMENT_ROW_COLUMNS)
    .in("id", ids)
    .eq("user_id", userId);
  if (error) throw error;

  const byId = new Map((rows ?? []).map((row) => [row.id, row as DocumentRow]));
  const containers = new Map<string, DocumentRow>();

  let refiled = 0;
  let skipped = 0;

  for (const item of items) {
    const doc = byId.get(item.id);
    if (!doc || !isRefileableQuickNote(doc)) {
      skipped += 1;
      continue;
    }

    const dateTag =
      item.dateTag && isDateTag(item.dateTag) ? item.dateTag : localDateTag(item.capturedAt);

    let container = containers.get(dateTag);
    if (!container) {
      container = await ensureContainer(admin, userId, item.capturedAt, dateTag, { sync: false });
      containers.set(dateTag, container);
    }

    const createdAtIso = item.capturedAt.toISOString();
    const alreadyThere = doc.parent_document_id === container.id;
    const createdMatches =
      new Date(doc.created_at).toISOString().slice(0, 19) === createdAtIso.slice(0, 19);
    if (alreadyThere && createdMatches) {
      skipped += 1;
      continue;
    }

    const { error: updateError } = await admin
      .from("documents")
      .update({
        parent_document_id: container.id,
        created_at: createdAtIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", doc.id)
      .eq("user_id", userId);
    if (updateError) throw updateError;

    doc.parent_document_id = container.id;
    doc.created_at = createdAtIso;
    refiled += 1;
  }

  if (refiled > 0) {
    await syncQuickNoteDatabases(admin, userId, parent.id);
  }

  return { refiled, skipped };
}
