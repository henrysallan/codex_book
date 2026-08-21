import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { storeGoogleRefreshToken } from "@/lib/googleToken";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/google/store-token
 *
 * Persists the Google OAuth refresh token for the calling user. The browser
 * used to upsert `user_google_tokens` with the anon key; that table is now
 * server-only. Body: `{ refresh_token: string }`.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth instanceof NextResponse) return auth;

  let refreshToken: string | undefined;
  try {
    const body = (await req.json()) as { refresh_token?: unknown };
    if (typeof body.refresh_token === "string") {
      refreshToken = body.refresh_token;
    }
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (!refreshToken) {
    return NextResponse.json({ error: "Missing refresh_token" }, { status: 400 });
  }

  const result = await storeGoogleRefreshToken(auth.id, refreshToken);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
