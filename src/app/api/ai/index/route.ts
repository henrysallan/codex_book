import { NextRequest, NextResponse } from "next/server";
import { indexDocument } from "@/lib/ai/indexDocument";

import { requireUserForAI } from "@/lib/serverAuth";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/ai/index
 *
 * Triggers the indexing pipeline for a single document.
 * Called after document save (debounced client-side).
 *
 * Pipeline: chunk → summarize/tag → embed → document-level summary/tags/embed
 */
export async function POST(req: NextRequest) {
  // These routes run with the service-role key and spend real LLM credits.
  // Requires Authorization: Bearer <supabase access token> — the web client
  // attaches it via authedFetch, trac3 via its Supabase session.
  const auth = await requireUserForAI(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { documentId } = body as { documentId: string };

    if (!documentId) {
      return NextResponse.json(
        { error: "Missing required field: documentId" },
        { status: 400 }
      );
    }

    const result = await indexDocument(documentId);

    console.log(
      `[/api/ai/index] ${result.status} doc=${documentId} ` +
      `total=${result.chunksTotal} new=${result.chunksNew} ` +
      `kept=${result.chunksKept} deleted=${result.chunksDeleted}` +
      (result.error ? ` error=${result.error}` : "")
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/ai/index] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
