import { NextRequest, NextResponse } from "next/server";
import { indexDocument } from "@/lib/ai/indexDocument";
import {
  getServerSupabase,
  isServerSupabaseConfigured,
} from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes — backfill can be slow

/**
 * POST /api/ai/backfill
 *
 * Re-indexes all documents (or a filtered subset).
 * Useful for initial population after running the AI migration,
 * or after changing the chunking/embedding strategy.
 *
 * Body (optional):
 *   - force: boolean — re-index even if content_hash matches (default false)
 *   - limit: number  — max documents to process (default all)
 */
export async function POST(req: NextRequest) {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Server Supabase not configured" },
      { status: 503 }
    );
  }

  let force = false;
  let limit: number | undefined;

  try {
    const body = await req.json().catch(() => ({}));
    force = body.force === true;
    limit = typeof body.limit === "number" ? body.limit : undefined;
  } catch {
    // empty body is fine — use defaults
  }

  const supabase = getServerSupabase();

  if (!supabase) {
    return NextResponse.json(
      { error: "Server Supabase client unavailable" },
      { status: 503 }
    );
  }

  // Fetch documents to index
  let query = supabase
    .from("documents")
    .select("id")
    .order("updated_at", { ascending: false });

  if (!force) {
    // Only index documents that haven't been indexed yet or have changed
    query = query.or("index_status.is.null,index_status.neq.indexed");
  }

  if (limit) {
    query = query.limit(limit);
  }

  const { data: docs, error: fetchErr } = await query;

  if (fetchErr) {
    console.error("[/api/ai/backfill] Error fetching documents:", fetchErr);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 }
    );
  }

  if (!docs || docs.length === 0) {
    return NextResponse.json({
      status: "done",
      message: "No documents to index",
      processed: 0,
      results: [],
    });
  }

  console.log(`[/api/ai/backfill] Starting backfill for ${docs.length} documents (force=${force})`);

  // If force-reindexing, clear content_hash so indexDocument won't skip them
  if (force) {
    const docIds = docs.map((d: { id: string }) => d.id);
    console.log(`[/api/ai/backfill] Force mode: clearing content_hash and chunks for ${docIds.length} docs`);

    // Null out content_hash so the hash-check in indexDocument won't short-circuit
    await supabase
      .from("documents")
      .update({ content_hash: null })
      .in("id", docIds);

    // Delete all existing chunks so they get fully regenerated
    await supabase
      .from("document_chunks")
      .delete()
      .in("document_id", docIds);
  }

  // Process documents sequentially to avoid rate limits
  const results: Array<{
    documentId: string;
    status: string;
    error?: string;
  }> = [];

  for (const doc of docs) {
    try {
      const result = await indexDocument(doc.id);
      results.push({
        documentId: doc.id,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      console.log(
        `[/api/ai/backfill] ${result.status} doc=${doc.id} ` +
        `total=${result.chunksTotal} new=${result.chunksNew}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        documentId: doc.id,
        status: "error",
        error: errMsg,
      });
      console.error(`[/api/ai/backfill] Error indexing ${doc.id}:`, err);
    }
  }

  const succeeded = results.filter((r) => r.status !== "error").length;
  const failed = results.filter((r) => r.status === "error").length;

  console.log(
    `[/api/ai/backfill] Complete: ${succeeded} succeeded, ${failed} failed out of ${docs.length}`
  );

  return NextResponse.json({
    status: "done",
    processed: docs.length,
    succeeded,
    failed,
    results,
  });
}
