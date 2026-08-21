import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { getServerSupabase } from "@/lib/supabaseServer";
import { isDateTag } from "@/lib/dateTag";
import { refileQuickNotes } from "@/lib/serverQuickNotes";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES = 80;

type BodyNote = {
  id?: string;
  capturedAt?: string;
  dateTag?: string;
};

/**
 * POST /api/mobile/refile-quick-notes
 *
 * Move already-created quick notes into the day container for their real
 * capture date. Cortex's parent-table Date column is the container's date tag,
 * not `documents.created_at`, so a PATCH of timestamps leaves the UI wrong.
 *
 * Request:  { notes: [{ id, capturedAt, dateTag? }] }
 * Response: { refiled, skipped }
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth instanceof NextResponse) return auth;

  const admin = getServerSupabase();
  if (!admin) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  let body: { notes?: BodyNote[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.notes) || body.notes.length === 0) {
    return NextResponse.json({ error: "Missing required field: notes" }, { status: 400 });
  }
  if (body.notes.length > MAX_NOTES) {
    return NextResponse.json(
      { error: `At most ${MAX_NOTES} notes per request` },
      { status: 400 }
    );
  }

  const items = [];
  for (const note of body.notes) {
    if (typeof note.id !== "string" || !UUID.test(note.id)) continue;

    let capturedAt: Date | undefined;
    if (typeof note.capturedAt === "string") {
      const parsed = new Date(note.capturedAt);
      if (!Number.isNaN(parsed.getTime())) {
        capturedAt = parsed.getTime() > Date.now() ? new Date() : parsed;
      }
    }
    if (!capturedAt) continue;

    const dateTag =
      typeof note.dateTag === "string" && isDateTag(note.dateTag) ? note.dateTag : undefined;

    items.push({ id: note.id, capturedAt, dateTag });
  }

  if (items.length === 0) {
    return NextResponse.json({ error: "No valid notes to refile" }, { status: 400 });
  }

  try {
    const result = await refileQuickNotes(admin, auth.id, items);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/mobile/refile-quick-notes] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
