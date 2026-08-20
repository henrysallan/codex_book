# Cortex / "Codex" — Deep Audit

**Audit date:** 2026-08-19 · **Branch:** `main` · **Commit:** `cab94a0`
**Auditor:** multi-agent review (5 parallel subsystem passes) synthesized into this set.
**Codebase:** ~17.7k lines TS/TSX across `src/`, 16 hand-run SQL migrations.

This folder is the deliverable. Start here, then read the subsystem files and the
[plan of attack](PLAN-OF-ATTACK.md).

---

## How to read this

- Every finding has an ID scoped to its subsystem file: **SEC-**, **DATA-**, **AI-**, **UI-**, **INF-**,
  followed by a severity letter + number (`C`ritical / `H`igh / `M`edium / `L`ow). Example: **SEC-C1**.
- The [Plan of Attack](PLAN-OF-ATTACK.md) sequences the fixes; it references those IDs.
- The subsystem files each open with a **SPEC** section (how the thing actually works, as built —
  not as the DEVGUIDE aspires) followed by ranked findings. The SPECs are usable on their own as
  up-to-date architecture docs.

---

## Table of contents

| # | File | Scope | Crit / High |
|---|---|---|---|
| 1 | [01-security.md](01-security.md) | Auth, RLS, API surface, secrets, prompt-injection, sharing | **4 / 5** |
| 2 | [02-data-layer.md](02-data-layer.md) | `db.ts`, `store.ts`, schema/type drift, migrations, cache, data loss | **4 / 5** |
| 3 | [03-ai-subsystem.md](03-ai-subsystem.md) | Router, retrieval, indexing, tool loop, SSE, cost | **3 / 8** |
| 4 | [04-ui-editor.md](04-ui-editor.md) | Editor, sidebar, tabs, panels, save/sync UX, a11y | **4 / 5** |
| 5 | [05-infra-build.md](05-infra-build.md) | Build health, deps, tooling, CI, config | **1 / 4** |
| — | [PLAN-OF-ATTACK.md](PLAN-OF-ATTACK.md) | Sequenced remediation, phased | — |
| — | [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Decisions only the owner can make | — |

---

## Executive summary

Cortex is a genuinely well-architected single-user knowledge base. The layering the DEVGUIDE
describes is real and mostly obeyed: components → store → `db.ts` → Supabase, one Zustand store,
BlockNote-JSON content, a tiered AI retrieval pipeline. TypeScript is clean under `strict`, the
build is green, there are zero `TODO`/`FIXME` markers, and the heavy components are correctly
code-split. The bones are good.

The audit nonetheless surfaced **16 Critical and 27 High** findings (some overlapping across
subsystems — deduplicated, roughly **9 distinct Critical** issues). They cluster into five themes:

### 1. "Single-tenant" is an assumption, not an enforcement — and it is false wherever the app is reachable

The DEVGUIDE §8 calls the AI routes "effectively single-tenant." That framing is dangerous. The
public **anon key ships in the browser bundle**, and Supabase leaves any table *without* RLS fully
readable and writable by that key. RLS is enabled on only **3 of ~13 tables**. The consequences,
all verified against source:

- **Google OAuth refresh tokens are world-readable and browser-written.** `user_google_tokens` has
  no RLS and is `upsert`ed directly from the browser ([auth.tsx:60](../../src/lib/auth.tsx#L60)).
  Anyone with the deployment URL can `select *` and exfiltrate every stored Drive refresh token. → **SEC-C1**, **DATA-C2**
- **Full note text is readable through the back door.** `document_chunks` (the chunked plaintext of
  every note + embeddings) and `annotations` (highlighted text + entire chat threads) have no RLS.
  The RLS on `documents` is cosmetic for confidentiality. → **SEC-C2**, **DATA-C2**
- **The search RPC leaks across users from the browser.** `search_documents` is `SECURITY DEFINER`
  with the `user_id = auth.uid()` filter *deliberately removed*
  ([search_documents_auth_fix.sql](../../supabase/search_documents_auth_fix.sql)), and it is called
  from the anon client. → **SEC-C3**, **DATA-C1**, **AI-C3**
- **The `/api/ai/*` routes are unauthenticated and service-role-backed.** Anyone can drive the tool
  loop to read/write notes and burn Anthropic/OpenAI/Groq budget; `/api/ai/backfill {force:true}` is
  an unauthenticated destructive re-embed of the entire corpus. → **SEC-C4**, **SEC-H1/H2/H3**, **AI-C3**, **AI-H7**
- **Google sign-in is open to any Google account.** Nothing pins the tenant. → **SEC-H4**

For a private, never-shared instance these are latent. But Vercel deployments have public URLs, and
the exposure is at the database/edge layer, below the app's own auth gate. Treat this as the
headline.

### 2. The write path silently loses data

There is no CRDT and no conflict resolution — that is a known, documented trade-off. The problem is
that even *single-writer* editing loses data:

- The 1-second debounced content save is **cancelled, not flushed, on unmount**
  ([DocumentEditor.tsx:700](../../src/components/DocumentEditor.tsx#L700)). Every doc switch, tab
  close, or pageLink click within ~1s of a keystroke discards the edit — and the stale cache shows
  the loss immediately. → **UI-C1**, **DATA-C4**
- There is **no `beforeunload` handler anywhere**, so closing the window mid-save loses it. → **UI-C2**
- Stale-cache reads plus whole-column last-write-wins mean a background refresh or a second
  tab/device can **silently overwrite** newer content; there is no `updated_at`/version check in
  `updateDocument`. → **DATA-C3**, **UI-H2**
- The 30-second AI-index debounce is dropped on the same unmount, and `index_status` still reads
  `"indexed"`, so the note is **never re-indexed** and backfill skips it. → **AI-H8**, **UI-H5**

### 3. Several UI actions are quietly destructive or mis-targeted

- The delete-folder dialog says "Documents inside will be moved to root." The backend **recursively
  deletes every descendant** with no undo. → **UI-C4**, **DATA-M8**
- Drag-and-drop has no ancestor-cycle check on 3 of 4 drop paths; creating a parent/child cycle
  makes the affected documents **vanish from the sidebar entirely**. → **UI-C3**
- Right-clicking a *nested child* document targets its **parent** — "Delete" destroys the parent and
  its whole subtree. → **UI-H3**

### 4. The AI feature has correctness and cost bugs in its core loop

- The agentic tool loop **drops the final answer** if the 6th model call still wants tools: it runs
  the tools, then exits to `done` with no synthesis call. → **AI-C1** (verified)
- Index writes **don't check Supabase errors**, yet `content_hash` advances unconditionally — a
  failed write produces a permanent, invisible index gap that only `force` backfill can repair. → **AI-C2**
- "Add to context" sends **empty content** for every non-active document (and whole folders),
  because `fetchDocuments` strips content to `"[]"`; the server trusts the client value and skips
  the DB fetch. Context-tier answers are generated from **blank documents**. → **UI-H1**
- The Groq limiter charges its 2.5s gap to *every caller* (2.5s added to each chat), and its
  per-lambda queue **can't protect the shared 30 RPM** across serverless instances. → **AI-H3**, **AI-H4**
- Router regex typos (`wrote|wrote`, missing `write`) misroute "what did I write about X" to
  GENERAL, so the user's own notes are never searched. → **AI-H5**

### 5. No engineering safety net

- **Next.js 16.1.6 carries ~28 published advisories**, fixed in 16.3.1 — the single highest-value
  one-line action given the unauthenticated routes. → **INF-C1**
- **No tests, no CI, no error boundaries.** A render throw white-screens the app, including the
  public share page; nothing gates a broken build from auto-deploying. → **INF-H2**, **INF-H3**
- **12 dependency vulnerabilities** (6 high) beyond Next; migrations have no runner, no ordering, and
  the auth migration is destructive and non-idempotent. → **INF-H4**, **DATA §4**

---

## Consolidated top findings (deduplicated)

Ranked by real-world risk, pointing at the authoritative subsystem entry.

| # | Issue | Severity | Primary ID | Also |
|---|---|---|---|---|
| 1 | Google refresh tokens world-readable + browser-written (no RLS) | Critical | [SEC-C1](01-security.md) | DATA-C2 |
| 2 | Full note text / annotations readable via anon key (RLS on 3/13 tables) | Critical | [SEC-C2](01-security.md) | DATA-C2 |
| 3 | `search_documents` SECURITY DEFINER, no user filter, called from browser | Critical | [SEC-C3](01-security.md) | DATA-C1, AI-C3 |
| 4 | `/api/ai/*` unauthenticated + service-role (read/write/cost/destructive) | Critical | [SEC-C4](01-security.md) | SEC-H1/H2/H3, AI-C3/H7 |
| 5 | Debounced save cancelled (not flushed) on unmount + no `beforeunload` → data loss | Critical | [UI-C1](04-ui-editor.md) | UI-C2, DATA-C4 |
| 6 | Stale-cache + last-write-wins silently overwrites newer content | Critical | [DATA-C3](02-data-layer.md) | UI-H2 |
| 7 | Delete-folder dialog lies; backend recursively hard-deletes all descendants | Critical | [UI-C4](04-ui-editor.md) | DATA-M8 |
| 8 | DnD parent/child cycles make documents disappear from the tree | Critical | [UI-C3](04-ui-editor.md) | — |
| 9 | Agentic tool loop drops the final answer at round-5 exhaustion | Critical | [AI-C1](03-ai-subsystem.md) | — |
| 10 | Index writes unchecked + `content_hash` advances → permanent invisible index gaps | Critical | [AI-C2](03-ai-subsystem.md) | — |
| 11 | Next.js 16.1.6 → 16.3.1 (~28 advisories) | Critical | [INF-C1](05-infra-build.md) | — |
| 12 | Context items send empty content → core RAG feature answers from blank docs | High | [UI-H1](04-ui-editor.md) | AI §1 |
| 13 | Child-doc right-click targets parent → wrong-target destructive delete | High | [UI-H3](04-ui-editor.md) | — |
| 14 | 30s index debounce dropped on unmount; `index_status` stays "indexed" → stale index | High | [AI-H8](03-ai-subsystem.md) | UI-H5 |
| 15 | Groq limiter adds 2.5s to every call + can't protect 30 RPM cross-instance | High | [AI-H3](03-ai-subsystem.md) | AI-H4 |
| 16 | Full-table fetches (no pagination) truncate at 1000 rows, then prune open tabs | High | [DATA-H2](02-data-layer.md) | — |
| 17 | No tests / CI / error boundaries | High | [INF-H2](05-infra-build.md) | INF-H3 |

---

## Severity rollup (raw, per subsystem — before cross-file dedup)

| Subsystem | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 4 | 5 | 5 | 3 |
| Data layer | 4 | 5 | 10 | 9 |
| AI subsystem | 3 | 8 | 13 | 9 |
| UI / editor | 4 | 5 | 15 | 14 |
| Infra / build | 1 | 4 | 5 | 5 |
| **Total (raw)** | **16** | **27** | **48** | **40** |

Roughly a third of the Criticals are the same 3–4 underlying issues (the RLS/anon-key exposure and
the search RPC) seen from different subsystems. See the consolidated table above for the
deduplicated view.

---

## What is genuinely good (keep it)

- Clean `tsc --noEmit` under `strict`; green build in ~13s.
- Correct dynamic-import splitting of tldraw / react-pdf ([EditorPanel.tsx](../../src/components/EditorPanel.tsx)).
- The `/api/drive/token` route is properly authenticated (validates the Supabase JWT) and keeps the
  Google client secret server-side — the one endpoint done right, and the model the others should copy.
- MoodboardCanvas's save loop (2s debounce, in-flight guard, dedup, **flush on unmount**) is the
  correct pattern; DocumentEditor should adopt it.
- Zero `TODO`/`FIXME`/`HACK` in `src/`; secrets are not committed (`.env.local` untracked).
- The chunk-diff-by-hash indexing design is cost-smart in principle (the bugs are in the write path,
  not the idea).

See each subsystem file for the full evidence and the exact fixes.
