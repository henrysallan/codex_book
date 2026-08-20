import { supabase } from "./supabase";

/**
 * `fetch` with the caller's Supabase session attached as a bearer token.
 *
 * WHY THE WEB CLIENT NEEDS THIS
 * -----------------------------
 * `/api/ai/*` used to run unauthenticated with the service-role key. That was a
 * defensible single-user shortcut while the only client was a browser on the
 * owner's machine. Shipping the trac3 iOS app changes the calculus: route URLs
 * end up inside a distributable binary, and these endpoints spend real
 * Anthropic / OpenAI / Groq credits on every call.
 *
 * The routes now require a bearer token (see src/lib/serverAuth.ts). The browser
 * has a cookie-backed session rather than a header, so this helper reads the
 * access token out of it and sets the header explicitly. Same identity, same
 * user — just proven in a way an API route can check without cookie plumbing.
 *
 * Streaming endpoints work unchanged: this returns the raw Response, so
 * /api/ai/chat's SSE body is still consumed with `res.body.getReader()`.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  return fetch(input, { ...init, headers });
}
