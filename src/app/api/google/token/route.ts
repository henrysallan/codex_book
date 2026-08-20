import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { mintGoogleAccessToken } from "@/lib/googleToken";

/**
 * POST /api/google/token
 *
 * Exchanges the caller's stored Google refresh token for a fresh access token.
 * Requires `Authorization: Bearer <supabase access token>`.
 *
 * This is the canonical route. `/api/drive/token` is a compatibility alias for
 * the existing web client and delegates to the same implementation.
 *
 * The returned token carries whatever scopes were granted at Supabase sign-in
 * (drive.readonly + calendar.events), so a single token serves both the Drive
 * browser on web and Google Calendar writes from trac3. There is no per-request
 * scope narrowing — Google issues access tokens against the grant, not the call.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth instanceof NextResponse) return auth;

  const result = await mintGoogleAccessToken(auth.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    access_token: result.accessToken,
    expires_in: result.expiresIn,
  });
}
