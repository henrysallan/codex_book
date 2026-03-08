import { createBrowserClient } from "@supabase/ssr";
import { SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Only create a real client if env vars are configured
const isConfigured =
  supabaseUrl.startsWith("http://") || supabaseUrl.startsWith("https://");

// Browser client — uses cookies for session persistence automatically
export const supabase: SupabaseClient | null = isConfigured
  ? createBrowserClient(supabaseUrl, supabaseAnonKey)
  : null;

export function isSupabaseConfigured(): boolean {
  return isConfigured;
}
