import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { getServerSupabase } from "@/lib/supabaseServer";
import { isDateTag } from "@/lib/dateTag";
import { createQuickNote } from "@/lib/serverQuickNotes";
import { indexDocument } from "@/lib/ai/indexDocument";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/mobile/quick-note
 *
 * The single write endpoint for trac3 captures. Requires
 * `Authorization: Bearer <supabase access token>`.
 *
 * WHY A ROUTE INSTEAD OF A DIRECT SUPABASE INSERT
 * -----------------------------------------------
 * iOS could insert into `documents` itself — RLS would allow it. But a bare
 * insert leaves two things undone:
 *
 *   1. The `database` blocks inside the Quick Notes parent and the day container
 *      still list the old set of notes. The sidebar tree updates (it derives from
 *      `parent_document_id`) but both tables go stale until the web app happens
 *      to capture something and resyncs.
 *   2. Nothing indexes it. Cortex's indexer is a 30s-debounced fetch from the
 *      web editor — a note created anywhere else is never chunked, summarised, or
 *      embedded, so the AI chat cannot retrieve it semantically. Keyword and
 *      trigram search still find it, which is what makes this failure quiet.
 *
 * Doing both here keeps iOS to one call and one retry story.
 *
 * IDEMPOTENCY
 * -----------
 * Pass `id` (trac3 sends its local `Note.id`). Re-posting the same id returns the
 * existing document with `created: false` instead of duplicating it, so the
 * offline outbox can retry freely.
 *
 * BACKFILL
 * --------
 * `capturedAt` (ISO 8601) places the note in the day container for the date it
 * was actually captured and sets the row's `created_at` accordingly. trac3 sends
 * it on every push, which is what lets an existing device history import with
 * its real dates instead of collapsing into today.
 *
 * `dateTag` (`YYYY-MM-DD` on the device calendar) is preferred over deriving the
 * day from `capturedAt` on the server. This route runs in UTC on Vercel, so an
 * evening capture in the US would otherwise land in tomorrow's folder.
 *
 * Re-posting an existing `id` with `capturedAt`/`dateTag` moves the note into
 * the matching day container instead of no-op'ing. That is how a first backfill
 * that dumped everything under today can be repaired without duplicating rows.
 *
 * Request:  { id?, text, markdown?, tags?, capturedAt?, dateTag?, index? }
 * Response: { documentId, created, title, containerId, indexed }
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth instanceof NextResponse) return auth;

  const admin = getServerSupabase();
  if (!admin) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  let body: {
    id?: string;
    text?: string;
    markdown?: string;
    tags?: string[];
    capturedAt?: string;
    dateTag?: string;
    index?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Missing required field: text" }, { status: 400 });
  }

  // Ignore an unparseable or absurd timestamp rather than rejecting the note —
  // a capture is worth more than its metadata. Future dates are clamped to now
  // so a device with a wrong clock can't create containers years ahead.
  let capturedAt: Date | undefined;
  if (typeof body.capturedAt === "string") {
    const parsed = new Date(body.capturedAt);
    if (!Number.isNaN(parsed.getTime())) {
      capturedAt = parsed.getTime() > Date.now() ? new Date() : parsed;
    }
  }

  const dateTag =
    typeof body.dateTag === "string" && isDateTag(body.dateTag) ? body.dateTag : undefined;

  let result;
  try {
    result = await createQuickNote(admin, auth.id, {
      id: body.id,
      text,
      markdown: body.markdown,
      tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : undefined,
      capturedAt,
      dateTag,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/mobile/quick-note] create failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Index inline. A quick note is a title plus at most a short body, so this is
  // one small Groq summarise and one embedding — well inside maxDuration. It is
  // still allowed to fail without failing the capture: the note exists, and it
  // remains findable by keyword search until the next backfill.
  let indexed = false;
  if (result.created && body.index !== false) {
    try {
      const indexResult = await indexDocument(result.document.id, auth.id);
      indexed = indexResult.status === "indexed";
      if (indexResult.status === "error") {
        console.warn(
          `[/api/mobile/quick-note] index error doc=${result.document.id}: ${indexResult.error}`
        );
      }
    } catch (err) {
      console.warn("[/api/mobile/quick-note] index threw:", err);
    }
  }

  return NextResponse.json({
    documentId: result.document.id,
    created: result.created,
    title: result.document.title,
    containerId: result.document.parent_document_id,
    indexed,
  });
}
