import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/serverAuth";
import { mintGoogleAccessToken } from "@/lib/googleToken";

/**
 * POST /api/drive/token
 *
 * Compatibility alias for POST /api/google/token, kept because the web Drive
 * browser already calls this path. The token exchange itself moved to
 * `src/lib/googleToken.ts` so the trac3 iOS app can reuse it for Calendar.
 *
 * Behaviour is unchanged: requires `Authorization: Bearer <supabase access token>`,
 * returns `{ access_token, expires_in }`.
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
