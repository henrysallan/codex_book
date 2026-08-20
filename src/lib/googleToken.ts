import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Google access-token minting.
 *
 * WHY THIS EXISTS ON THE SERVER
 * -----------------------------
 * Two different Google OAuth clients are in play:
 *
 *   - Cortex/Supabase uses a **web** client (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET).
 *   - trac3 previously used its own **iOS** client, which refreshes with PKCE and
 *     needs no secret.
 *
 * A Google refresh token is bound to the client that issued it. Once trac3 signs
 * in through Supabase, its refresh token comes from the *web* client, so
 * refreshing it requires the client secret — which must never ship in an app
 * binary. Hence: the exchange happens here, and iOS calls this with its Supabase
 * session as proof of identity.
 *
 * Reads `user_google_tokens` with the SERVICE ROLE key, which bypasses the RLS
 * added in supabase/rls_user_google_tokens_migration.sql. That is intentional and
 * safe: the caller's identity is verified before we get here, and we only ever
 * look up the row for that verified user id.
 */

export type GoogleTokenResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; status: number; error: string };

/**
 * Exchange the stored Google refresh token for a fresh access token.
 *
 * @param userId a uuid already verified via `requireUser` — never a value read
 *               straight from a request body.
 */
export async function mintGoogleAccessToken(userId: string): Promise<GoogleTokenResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!supabaseUrl || !supabaseServiceKey) {
    return { ok: false, status: 500, error: "Supabase not configured (service role key required)" };
  }
  if (!googleClientId || !googleClientSecret) {
    return {
      ok: false,
      status: 500,
      error: "Google OAuth credentials not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)",
    };
  }

  const admin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // user_google_tokens.user_id is `text` while auth user ids are uuid — cast to
  // match the column as it exists today.
  const { data: row, error: dbErr } = await admin
    .from("user_google_tokens")
    .select("refresh_token")
    .eq("user_id", String(userId))
    .maybeSingle();

  if (dbErr) {
    console.error("[googleToken] lookup failed:", dbErr.message);
    return { ok: false, status: 500, error: "Could not read stored Google token" };
  }

  if (!row?.refresh_token) {
    return {
      ok: false,
      status: 401,
      error: "No Google refresh token stored. Sign in again with Google to grant offline access.",
    };
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    // Body may name the failure (invalid_grant = revoked or expired token) but
    // can also echo request material, so it is logged and not returned.
    const errBody = await tokenRes.text();
    console.error("[googleToken] Google refresh failed:", errBody);
    return {
      ok: false,
      status: 401,
      error: "Google token refresh failed. You may need to sign in again.",
    };
  }

  const tokenData = await tokenRes.json();
  return {
    ok: true,
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in ?? 3600,
  };
}
