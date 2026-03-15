import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/drive/token
 *
 * Exchanges the stored Google refresh_token for a fresh access_token.
 * This runs server-side so the Google client_secret stays private.
 */
export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }
  if (!googleClientId || !googleClientSecret) {
    return NextResponse.json(
      { error: "Google OAuth credentials not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)" },
      { status: 500 }
    );
  }

  // Resolve the current user from their Supabase auth token
  const authHeader = req.headers.get("authorization") ?? "";
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const anonClient = createClient(supabaseUrl, supabaseAnon);
  const token = authHeader.replace("Bearer ", "");

  // Try to get user from the request's Supabase token (cookie-based or header)
  let userId: string | null = null;

  if (token && token !== "") {
    const { data } = await anonClient.auth.getUser(token);
    userId = data?.user?.id ?? null;
  }

  if (!userId) {
    // Fallback: try getting session from the cookie-forwarded headers
    // For browser requests, cookies are sent automatically
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Fetch the stored refresh token
  const admin = createClient(supabaseUrl, supabaseServiceKey);
  const { data: row, error: dbErr } = await admin
    .from("user_google_tokens")
    .select("refresh_token")
    .eq("user_id", userId)
    .single();

  if (dbErr || !row?.refresh_token) {
    return NextResponse.json(
      { error: "No Google refresh token stored. Please sign in again with Google." },
      { status: 401 }
    );
  }

  // Exchange refresh_token for a new access_token
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
    const errBody = await tokenRes.text();
    console.error("Google token refresh failed:", errBody);
    return NextResponse.json(
      { error: "Google token refresh failed. You may need to sign in again." },
      { status: 401 }
    );
  }

  const tokenData = await tokenRes.json();
  return NextResponse.json({
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in ?? 3600,
  });
}
