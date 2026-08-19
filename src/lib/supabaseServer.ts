import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase client using the service role key (preferred)
// or the anon key (fallback for read operations).
// Only use this in API routes / server-side code — never import on the client.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Use service role key if available, otherwise fall back to anon key
const effectiveKey = supabaseServiceKey.length > 0 ? supabaseServiceKey : supabaseAnonKey;

const isConfigured =
  (supabaseUrl.startsWith("http://") || supabaseUrl.startsWith("https://")) &&
  effectiveKey.length > 0;

let _client: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient | null {
  if (!isConfigured) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, effectiveKey, {
      auth: { persistSession: false },
    });
    if (!supabaseServiceKey) {
      console.warn(
        "[supabaseServer] SUPABASE_SERVICE_ROLE_KEY not set — using anon key as fallback. " +
        "Some operations may fail due to RLS policies."
      );
    }
  }
  return _client;
}

export function isServerSupabaseConfigured(): boolean {
  return isConfigured;
}
