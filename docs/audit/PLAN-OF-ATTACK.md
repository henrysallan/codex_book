# Plan of Attack

A sequenced remediation plan. Phases are ordered by **risk-reduction per unit effort** and by
dependency (do the cheap safety net before the big refactors). Each item references the authoritative
finding ID; open the subsystem file for the exact code and fix.

**Decisions (2026-08-20):** prep for multi-user without treating it as on-fire; **AI search
privacy is in scope now**; token budget / Groq limiter / shared Redis bucket are deferred. That
means Phase 0 is still first (RLS, user-scoped search RPCs, authenticated AI routes that filter by
the caller) but SEC-H4 allowlisting and AI-H3/H4 cost work wait. Phase 1 (data loss) stays next.

The original guiding question: **[is this instance ever reachable by anyone but you?](OPEN-QUESTIONS.md#q1)**
If yes, Phase 0 is an emergency. If it is genuinely a private single-user instance on a URL nobody
else has, Phase 0 drops to "important but not on fire" and Phase 1 (data loss) becomes your real
top priority — you are losing your own edits today.

---

## Phase 0 — Stop the bleeding (security), ~1–2 days

The whole cluster is one root cause: **the anon key ships in the browser and the database is not
locked down behind it.** Do these together; individually they leave holes.

1. **Enable RLS + owner policies on every table.** chunks/annotations/pdf_annotations/attachments/
   moodboard scope via a join to `documents.user_id`; `usage_logs` and `user_google_tokens` via
   `user_id`. `revoke all ... from anon, authenticated` on anything not meant to be client-reachable.
   → SEC-C1, SEC-C2, DATA-C2
2. **Move the Google refresh-token write server-side** and never let the client touch
   `user_google_tokens`. → SEC-C1
3. **Fix `search_documents`:** add a `p_user_id uuid` parameter and filter on it (or make it
   `SECURITY INVOKER`). Update the `db.ts:650` call site to pass the current user id. → SEC-C3, DATA-C1
4. **Authenticate every `/api/ai/*` route** (copy the `/api/drive/token` pattern: validate the
   Supabase bearer JWT, derive `user_id`, pass it into every query). This closes the IDOR, the
   destructive backfill, the usage leak, and the denial-of-wallet in one move. → SEC-C4, H1, H2, H3
5. **Fail closed** in `supabaseServer` if the service key is missing (throw in production). → SEC-H5
6. **`npm audit fix` + upgrade Next to 16.3.1.** The framework is the only shield until the routes are
   authed, and it's a one-liner. → INF-C1, INF-H4
7. Pin/allowlist Google sign-in to your identity (hd/email), or gate the app to a known user id. → SEC-H4

**Exit criteria:** an anonymous `curl` of the deployment can no longer read `user_google_tokens`,
`document_chunks`, or `/api/ai/usage`, and cannot drive `/api/ai/chat` or `/api/ai/backfill`.

---

## Phase 1 — Stop losing data, ~2–3 days

You are losing your own edits today; this is the highest-value *correctness* work.

1. **Flush timers on unmount.** In `DocumentEditor` cleanup, flush the 1s content save and fire the
   index trigger instead of `clearTimeout`. Copy MoodboardCanvas's pattern. → UI-C1, DATA-C4, UI-H5, AI-H8
2. **Add a `beforeunload`/`visibilitychange` guard** keyed on `syncStatus !== "synced"`, with a
   `sendBeacon` flush. → UI-C2
3. **Version-guard writes.** Add `updated_at` (or a version int) checking to `updateDocument`; refuse/
   merge a save whose base is stale, and stop the background refresh from clobbering the cache with a
   per-doc fetch token. → DATA-C3, UI-H2
4. **Re-seed BlockNote (or block the save) when a background refresh replaces `activeDocument`.** → DATA-C3
5. **Mark the index dirty on save** (`index_status='stale'` or clear `content_hash`) so a dropped 30s
   trigger is still caught by backfill. → AI-H8

**Exit criteria:** typing then immediately switching docs / closing the tab never loses the last
edit; a second tab can't silently overwrite the first.

---

## Phase 2 — Fix the destructive & mis-targeted UI actions, ~1–2 days

1. **Ancestor-cycle check** before every `setParentDocument`/`moveFolder`, including the multi-drag
   path. → UI-C3
2. **Fix the child-doc context-menu closure** so a nested doc's menu targets itself, not its parent.
   One-line, prevents a wrong-target delete. → UI-H3
3. **Make the delete-folder dialog honest** — either change the copy or make the backend actually move
   descendants to root. → UI-C4, DATA-M8
4. **Branch drive tabs in `closeTab`** so closing onto a Drive fallback doesn't throw. → UI-H4
5. **Roll back optimistic mutations on failure** and surface an error toast (create/rename/delete/
   move all currently `.catch(console.error)` and diverge from the server). → DATA-H3, UI-M10, UX note 1

---

## Phase 3 — Make the AI feature correct & affordable, ~3–4 days

1. **Fix the tool-loop terminator** — on round-5 exhaustion, force a final answer call (as the token-
   budget branch already does) instead of dropping to `done`. → AI-C1
2. **Check every Supabase write in `indexDocument`** and only advance `content_hash` on full success;
   surface failures via `index_status='error'`. → AI-C2
3. **Treat `content==="[]"` as missing** in `resolveDoc`/the chat route so context items and folders
   carry real content. Restores the headline RAG feature. → UI-H1
4. **Rework `groqLimiter`:** enforce the gap *between* items (resolve first), and move to a shared
   token bucket (Upstash/Redis) so the 30 RPM holds across lambdas. → AI-H3, AI-H4
5. **Fix the router regexes** (`write`, the `wrote|wrote` typo, GENERAL vs "what did I write"). → AI-H5
6. **Split oversized blocks** before embedding so one big paragraph can't fail the whole doc. → AI-H6
7. **Make force-backfill per-document destructive** (clear each doc's chunks just before re-indexing
   it), not global-delete-up-front. → AI-H7
8. **Buffer SSE across reads** on the client so events straddling TCP boundaries aren't dropped;
   wire an abort path (Stop button + `req.signal`) server- and client-side. → AI-H2, AI-H1, UI-M7
9. **Retrieval quality:** RRF/normalization in rerank; pass FTS snippets through; index a
   stripped-plaintext generated column instead of raw BlockNote JSON. → AI-M10, retrieval §3

---

## Phase 4 — Scale & data-model hygiene, ~2–3 days

1. **Paginate `fetchDocuments`/`fetchFolders`** (range or keyset) so >1000 docs don't truncate and
   silently prune open tabs. → DATA-H2
2. **Back the remaining `ensure*` helpers with partial unique indexes** (quick_note_parent, per-day
   daily/container) and use `upsert`/`onConflict`; fix the UTC-vs-local date-boundary bug. → DATA-H1
3. **Debounce the dashboard sync** and stop rewriting whole system-doc contents on every mount; fix the
   O(days) N+1 in `syncQuickNoteDatabases`. → DATA-H4, DATA-H5
4. **Stop `select("*")` on documents** — use `DOCUMENT_META_COLUMNS` so embeddings/tsvectors don't ship
   to the browser. → DATA-M3
5. **Reconcile schema/type drift** (add the 6 missing DbDocument columns, DbBacklink.user_id,
   DbAnnotation.summary/embedding) and guard the raw `JSON.parse`s. → DATA §2, DATA-M4
6. **Adopt a real migration workflow** (`supabase/migrations/` timestamped + CLI tracking), make
   triggers/policies idempotent, regenerate a true baseline, add the missing CHECK constraints, and
   create the IVFFlat indexes. → DATA §4, AI-L9

---

## Phase 5 — Engineering safety net & polish, ~2–3 days

1. **Add minimal CI** (`tsc --noEmit` + `next build`) so a broken commit can't auto-deploy. → INF-H2
2. **Add `error.tsx` + `global-error.tsx`** (at least on `/share/[slug]`). → INF-H3
3. **Add `public/**` to eslint ignores**, delete `@types/uuid`, `--fix` dead imports, fix the 16 real
   lint errors (incl. the ChatPanel missing-deps stale closure). → INF-H1, INF-M3
4. **Remove prod/dev cruft:** delete or dev-gate `/pdf-test`, remove `debug-share.mjs`, drop the dead
   `SearchDialog.tsx`/`NotionImport.tsx`/`blocksToMarkdown.ts` (or park them intentionally). → UI-L1, INF-M2
5. **Pin Node** (`engines` + `.nvmrc`), align `@types/node`. → INF-M4
6. **Accessibility pass** on modals (role/aria-modal/focus trap/Escape) and icon buttons. → UI-M14
7. **Debounce note-settings writes**, fix BacklinksPanel deps, memoize the Sidebar rows and the
   editor's `JSON.parse`, key the init effect on `user?.id`. → UI-M2, M3, M5, M6, M11
8. **Pick one product name.** → UX note 2
9. Schedule the BlockNote and Anthropic-SDK upgrades as their own de-risked tasks. → INF-M5

---

## Suggested order if you only have a week

Phase 0 (if reachable) → Phase 1 → AI-C1 + AI-C2 + UI-H1 (the three AI correctness bugs that make the
product feel broken) → UI-C3/C4/H3 (the three destructive UI bugs) → INF-C1/H2/H3 (upgrade + CI +
error boundary). Everything else is real but can wait.
