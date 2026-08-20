import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { getServerSupabase } from "@/lib/supabaseServer";
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
 * Request:  { id?, text, markdown?, tags?, index? }
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

  let result;
  try {
    result = await createQuickNote(admin, auth.id, {
      id: body.id,
      text,
      markdown: body.markdown,
      tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : undefined,
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
      const indexResult = await indexDocument(result.document.id);
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
