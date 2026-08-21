import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase client using the service role key.
// Only use this in API routes / server-side code — never import on the client.
//
// The service role bypasses RLS. Callers must filter by a JWT-verified user id
// on every query that touches user data. Do not fall back to the anon key:
// that silently degrades privileged routes onto tables that (historically)
// had no RLS.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const urlOk =
  supabaseUrl.startsWith("http://") || supabaseUrl.startsWith("https://");

let _client: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient | null {
  if (process.env.NODE_ENV === "production" && !supabaseServiceKey) {
    throw new Error(
      "[supabaseServer] SUPABASE_SERVICE_ROLE_KEY is required in production"
    );
  }
  if (!urlOk || !supabaseServiceKey) {
    if (!supabaseServiceKey && urlOk) {
      console.warn(
        "[supabaseServer] SUPABASE_SERVICE_ROLE_KEY not set — server DB client disabled."
      );
    }
    return null;
  }
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

export function isServerSupabaseConfigured(): boolean {
  return urlOk && supabaseServiceKey.length > 0;
}
