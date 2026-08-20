# 01 — Security & API Surface

**Finding IDs:** `SEC-C1` … `SEC-L3`. Referenced elsewhere as "Security C1", etc.
**Scope:** auth flow, RLS matrix, `/api/*` routes, secrets, storage, prompt-injection blast radius,
sharing. All line references verified against commit `cab94a0`.

> **Framing:** the app is single-user *by intent*. None of that is *enforced* below the app layer.
> The anon key ships in the browser bundle, so every finding below that starts "anyone with the
> deployment URL" is reachable by anyone who has ever been given the link — the app's own auth gate
> does not protect the database. The three most load-bearing claims (SEC-C1, SEC-C3, and the tool
> loop) were re-verified against source during synthesis.

---

## 1. Security posture — SPEC

### 1.1 Auth flow
- Google OAuth is handled entirely by Supabase Auth on the **browser** client
  ([auth.tsx:72-83](../../src/lib/auth.tsx#L72-L83)). Sign-in requests scope
  `https://www.googleapis.com/auth/drive.readonly` with `access_type: offline, prompt: consent`.
- On every auth state change the browser **upserts the Google refresh token** into
  `user_google_tokens` **using the public anon client** ([auth.tsx:59-66](../../src/lib/auth.tsx#L59-L66)).
- Session persistence is cookie-based via `@supabase/ssr` `createBrowserClient`.
- There is **no Next.js middleware** (no `middleware.ts`), so nothing enforces auth at the edge.
  App-level gating is client-side only (`page.tsx` auth gate).

### 1.2 Two Supabase clients
- **Browser/anon** ([supabase.ts](../../src/lib/supabase.ts)): `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Used
  by all of `db.ts`/`store.ts`. RLS applies.
- **Server/service-role** ([supabaseServer.ts](../../src/lib/supabaseServer.ts)):
  `SUPABASE_SERVICE_ROLE_KEY`, **silently falls back to the anon key** if the service key is absent
  (lines 11-12, 26-31). RLS bypassed when the service key is present. Used by every `/api/ai/*`
  route, the share route/page, and all of `src/lib/ai/*`.

### 1.3 API route matrix

| Route | Method | Auth? | Client | Accepts | Returns |
|---|---|---|---|---|---|
| `/api/ai/chat` | POST | **None** | service-role | messages, activeDocument*, contextItems, tier, modelOverride | SSE; 5-round tool loop over ~27 tools incl. `create_note` |
| `/api/ai/annotate` | POST | **None** | service-role | annotationId, documentId, highlightedText, messages | SSE; reads any doc, **writes** `annotations.summary/embedding` for arbitrary id |
| `/api/ai/index` | POST | **None** | service-role | documentId | indexes/embeds a doc (OpenAI+Groq spend) |
| `/api/ai/backfill` | POST | **None** | service-role | force, limit, documentIds | re-indexes; `force` deletes+regenerates all chunks |
| `/api/ai/usage` | GET | **None** | service-role | ?days | aggregated cost/token/model/day telemetry |
| `/api/drive/token` | POST | **Yes** (Bearer Supabase JWT) | anon (validate) + service-role (read) | `Authorization: Bearer <jwt>` | fresh Google access_token for *that* user |
| `/api/share/[slug]` | GET | Public (by design) | service-role | slug | shared doc fields + pageLinkMap |
| `/share/[slug]` (RSC) | GET | Public (by design) | service-role | slug | rendered read-only note |

No route sets CORS headers — moot, since the sensitive routes are unauthenticated anyway.

### 1.4 RLS matrix (table × policy)

A public-schema table **without RLS enabled** is fully readable/writable by the `anon` role, whose
key is in the browser bundle.

| Table | RLS | Effective anon access |
|---|---|---|
| `documents` | **ON** | own rows + any row with non-null `share_slug` (all columns) |
| `folders` | **ON** | own only |
| `backlinks` | **ON** | own only |
| `document_chunks` | **OFF** | **full read/write of all chunk content + embeddings** |
| `annotations` | **OFF** (commented) | **full read/write** (highlighted text + chat messages) |
| `pdf_annotations` | **OFF** | full read/write |
| `attachments` | **OFF** | full read/write (drive_file_id links) |
| `user_google_tokens` | **OFF** | **full read of every Google refresh_token** |
| `usage_logs` | **OFF** | full read/write |
| `moodboard_state` / `_objects` / `_assets` | **OFF** (commented) | full read/write |

### 1.5 SECURITY DEFINER functions
- `search_documents(text)` — final version
  ([trigram_search_migration.sql:95](../../supabase/trigram_search_migration.sql#L95)) is
  **SECURITY DEFINER with no `user_id = auth.uid()` filter** (removed intentionally in
  `search_documents_auth_fix.sql`). Called from the **browser anon client** at
  [db.ts:650](../../src/lib/db.ts#L650).
- `match_chunks`, `match_documents`, `match_annotations`, `get_all_tags` — plain `plpgsql` (invoker
  rights), but the underlying tables have no RLS, so results are unrestricted anyway.

### 1.6 Storage buckets
- `moodboard-assets` is created **PUBLIC** and **all storage RLS policies are commented out**
  (`moodboard_migration.sql`). No upload code ships today, but any configured bucket is public-read
  with no object-level policy.

---

## 2. Findings

### CRITICAL

**SEC-C1 — Google OAuth refresh tokens are world-readable via the public anon key.**
`user_google_tokens` has no RLS (`schema.sql:133-137`). The anon key is in the client bundle. Any
visitor can `supabase.from('user_google_tokens').select('*')` and exfiltrate every stored
`refresh_token` — long-lived Google credentials with `drive.readonly` scope. Writes are open too
(overwrite a victim's token). The token is also **written from the browser**
([auth.tsx:60](../../src/lib/auth.tsx#L60)) — *verified*. The refresh token alone isn't exchangeable
without `GOOGLE_CLIENT_SECRET`, but `/api/drive/token` will exchange it for a live access token for
any authenticated session.
*Fix:* enable RLS with a self-only policy, `revoke all ... from anon, authenticated`, and write the
token from a server route only — never let the client touch this table.

**SEC-C2 — Full note content readable/writable through unprotected satellite tables, defeating RLS on
`documents`.** `document_chunks` (chunked full text + 1536-d embeddings of every note) has no RLS;
`annotations` (highlighted text + entire chat threads) has RLS commented out. With the anon key,
`select('content')` returns every note's text; inserts/updates/deletes are unrestricted. Same for
`pdf_annotations`, `attachments`, `usage_logs`, all `moodboard_*`. The `documents` RLS is therefore
cosmetic for confidentiality.
*Fix:* enable RLS + owner policies on every table (chunks/annotations/attachments/moodboard scope via
a join to `documents.user_id`; `usage_logs` via `user_id`); revoke default grants on anything not
meant to be client-reachable.

**SEC-C3 — `search_documents` RPC leaks all users' content cross-tenant from the browser.**
[db.ts:650](../../src/lib/db.ts#L650) calls it on the **anon** client. The deployed function is
`SECURITY DEFINER` with no user filter (*verified*: the auth-fix migration header documents the
removal), so it returns titles/tags/snippets across every user's documents — a direct bypass of the
`documents` SELECT policy.
*Fix:* add a `p_user_id uuid` parameter (or restore `where d.user_id = auth.uid()`), or make it
`SECURITY INVOKER` so RLS applies to the caller.

**SEC-C4 — Unauthenticated, service-role-backed AI endpoints (data read/write + denial-of-wallet).**
`/api/ai/{chat,annotate,index,backfill,usage}` perform **no auth check** and use the service-role
client. A crafted `POST /api/ai/chat` drives the tool loop to read **all** notes and `create_note` to
**write** arbitrary documents, at up to 5 tool rounds / 35k-token ceiling per call, unmetered.
*Fix:* require and validate a Supabase JWT on every `/api/ai/*` route (as `/api/drive/token` already
does), derive `user_id` from it, and pass that into every query rather than trusting the service role
to be single-tenant.

### HIGH

**SEC-H1 — `/api/ai/annotate` is an unauthenticated read+write IDOR.** `documentId` is
attacker-controlled and service-role-read for any doc; `embedAnnotation` runs
`update annotations set summary=…, embedding=… where id = annotationId` for an attacker-supplied id
(`annotate/route.ts:154-158`), letting anyone overwrite any annotation and inject text/embeddings.
Burns Anthropic tokens per call. *Fix:* authenticate; verify ownership of the doc and annotation.

**SEC-H2 — `/api/ai/backfill` unauthenticated destructive + cost bomb.**
`POST {"force":true}` nulls `content_hash` and **deletes all `document_chunks`**, then re-embeds
everything (`maxDuration=300`). Anyone can trigger a full repeated re-embed (denial-of-wallet) and
churn the index. *Fix:* authenticate; owner/admin-only. (See also AI-H7 for the destructive-first
ordering bug.)

**SEC-H3 — `/api/ai/usage` leaks telemetry unauthenticated.** Returns per-flow/day/model token counts
and estimated USD with no auth. The underlying `usage_logs` is also anon-readable (SEC-C2) and
carries `document_id`s. *Fix:* authenticate; scope to caller.

**SEC-H4 — Open Google sign-up undermines the "single-tenant" assumption.** Google OAuth is not
restricted to a specific account, so **any Google user** can authenticate and create data; because
the service-role AI paths never filter by `user_id`, their notes can surface to the owner.
`create_note` even assigns ownership by copying the `user_id` of an arbitrary first `documents` row
(`tools.ts:2168-2174`), cross-contaminating tenants. *Fix:* restrict allowed identities (hd/email
allowlist) or pin to a known user id; add per-user filtering to all AI DB access.

**SEC-H5 — `supabaseServer` silent anon fallback hides a security-critical misconfiguration.** If
`SUPABASE_SERVICE_ROLE_KEY` is unset, `getServerSupabase()` returns an **anon** client
([supabaseServer.ts:11-12,26-31](../../src/lib/supabaseServer.ts#L11-L12)). Privileged ops then run
as anon: some fail under RLS (confusing), but reads/writes on the unprotected tables (SEC-C2) still
succeed. A deploy that forgets the key degrades silently instead of failing closed. *Fix:* throw/500
in production if the service key is missing.

### MEDIUM

**SEC-M1 — Prompt-injection blast radius through the tool loop.** Retrieved note content is fed to
Claude with `create_note` available. A note whose body contains instructions can drive the model to
**write new documents** (data poisoning, potentially self-propagating across re-index). *Mitigating:*
there is **no web-fetch/URL tool and no SSRF surface** in `tools.ts` (all executors are
Supabase-only), so no external exfiltration channel, and tools are read-only except `create_note`.
*Fix:* mark retrieved content as untrusted in the system prompt; require explicit confirmation before
`create_note` persists, or gate writes behind a per-request flag.

**SEC-M2 — No rate limiting or body-size limits on any route.** `groqLimiter` only paces outbound
Groq calls. `/api/ai/chat` accepts unbounded `messages`/`activeDocumentContent`/`contextItems`.
Combined with SEC-C4 this is straightforward denial-of-wallet / DoS. *Fix:* auth + per-user token
bucket; reject oversized bodies.

**SEC-M3 — Share slug enumeration exposure.** Slugs are 8 chars over 36 symbols via
`crypto.getRandomValues` (good randomness, ~2.8e12 space), but the public endpoint accepts any slug
`length >= 4` with no rate limiting, so the space is online-enumerable, and each hit returns the full
note body. The `Public read for shared documents` RLS policy also exposes **all columns** of any
shared row to the anon key directly. *Fix:* keep slugs ≥ generated length, rate-limit, tighten the
policy to a column-limited view.

**SEC-M4 — Drive token scope over-broad.** `/api/drive/token` is correctly authenticated and returns
only the caller's token — good. But the granted scope is `drive.readonly`, so the minted token can
read the user's **entire** Drive, not just the `Codex` folder. *Fix:* request `drive.file` scope.

**SEC-M5 — No security headers / CSP.** `next.config.ts` sets no `headers()` — no CSP, HSTS,
X-Frame-Options. The share page renders arbitrary stored content. *Fix:* add a `headers()` block.

### LOW

**SEC-L1 — Unsanitized link hrefs from AI-authored markdown (stored-XSS vector).** `parseInline`
(`tools.ts:2107-2113`) builds BlockNote `link` nodes with `href: match[2]` verbatim —
`javascript:`/`data:` not filtered. A `create_note` result (or injected content) can persist a
malicious link. Impact depends on BlockNote's href handling. *Fix:* allowlist `http(s):`/`mailto:`.

**SEC-L2 — Verbose logging of sensitive content.** Routes log resolved queries, affirmation text, and
tool inputs. Note content/queries land in server logs. *Fix:* redact in production.

**SEC-L3 — `create_note` ownership heuristic.** Ownership is assigned from an arbitrary `documents`
row (`limit(1)`); misattributes in any multi-writer scenario. Tied to SEC-H4.

---

## 3. DEVGUIDE accuracy check

- §8's factual claims (RLS on 3 tables, share policy, unauthenticated service-role AI routes) are
  **accurate**, but the framing "effectively single-tenant" is **misleading as a safety statement**:
  the anon key can directly read/write every unprotected table including refresh tokens and full note
  text, Google sign-in is open, and the search RPC leaks cross-tenant. The guide treats "other tables
  unprotected" as benign when it is the app's most serious exposure.
- §10 "the client secret never ships to the browser" — **accurate**. Worth noting `/api/drive/token`
  is the *only* authenticated route while all `/api/ai/*` are open.
- §10 on the `supabaseServer` anon fallback — **accurate but understated**: it is a fail-open risk
  (SEC-H5), not merely "confusing."
