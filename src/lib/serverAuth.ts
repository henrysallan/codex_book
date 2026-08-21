import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Bearer-token authentication for API routes.
 *
 * Most of `/api/*` historically ran unauthenticated with the service-role key —
 * a deliberate single-user simplification back when the only client was a
 * browser on the owner's machine. The trac3 iOS app changes that: route URLs
 * ship inside a distributable binary, so they need to prove who is calling.
 *
 * The verification pattern is the one already used by /api/drive/token: hand the
 * caller's Supabase access token to the ANON client's `auth.getUser`, which
 * validates the JWT signature and expiry against the project's keys. Never trust
 * a user id sent in a request body.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export type AuthedUser = {
  /** uuid — matches `documents.user_id` directly, and `*.user_id` text columns after a `String()` cast. */
  id: string;
  email: string | null;
};

/**
 * Resolve the calling user from an `Authorization: Bearer <supabase access token>`
 * header. Returns null when the header is missing, malformed, or the token does
 * not validate. Callers decide whether that is fatal.
 */
export async function getUserFromRequest(req: Request): Promise<AuthedUser | null> {
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data?.user) return null;

  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Strict variant: returns either the user or a ready-to-return 401 response.
 *
 * ```ts
 * const auth = await requireUser(req);
 * if (auth instanceof NextResponse) return auth;
 * // auth.id is a verified uuid from here on
 * ```
 */
export async function requireUser(req: Request): Promise<AuthedUser | NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: "Not authenticated. Send Authorization: Bearer <supabase access token>." },
      { status: 401 }
    );
  }
  return user;
}

/**
 * Same as `requireUser`. Kept as a named alias so `/api/ai/*` call sites
 * read as an auth gate rather than an optional check.
 */
export async function requireUserForAI(
  req: Request
): Promise<AuthedUser | NextResponse> {
  return requireUser(req);
}
