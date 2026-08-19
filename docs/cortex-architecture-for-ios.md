# Cortex — Architecture & Integration Guide

**Audience:** the agent building the iOS companion app (quick ideas + rapid summaries).
**Purpose:** everything you need to know about the existing Cortex web app to integrate with it — data model, content format, auth, AI pipeline, HTTP surface, and the sharp edges.

Repo: `github.com/henrysallan/codex_book` · Deployed on Vercel (project `codex-book`) · Next.js 16 App Router.

---

## 0. TL;DR for the iOS app

Cortex is a **single-user, document-first personal knowledge base**: a Notion-style block editor over Supabase Postgres, with a Claude-powered chat panel that retrieves from a pgvector index of the user's notes.

For an iOS app about **quick ideas and rapid summaries**, the three things that matter:

1. **Everything lives in one Supabase Postgres instance.** The iOS app can talk to it directly with the Supabase Swift SDK using the same Google OAuth identity. `documents` and `folders` are RLS-protected per `user_id`; several other tables are not (see §5).
2. **Document bodies are BlockNote JSON, not markdown** — a JSON-stringified array of block objects in `documents.content`. Writing plain text into that column will render as garbage in the web editor. See §4 for the exact shape and a minimal writer.
3. **There is already a "Quick Notes" hierarchy** (`quick_note_parent` → per-day container → individual note) plus a daily-note and todo system. An iOS capture flow should write into that hierarchy, not invent a new one. See §9.

The AI endpoints (`/api/ai/*`) are **unauthenticated and service-role-backed** today. They work as-is from a mobile client, but they are effectively single-tenant. See §5 and §10 before shipping.

---

## 1. What Cortex is

A personal knowledge OS built around three ideas:

- **The document is the primary artifact.** Not a database row, not a chat thread.
- **AI lives alongside the document, never inside it.** The chat panel reads, retrieves, and reasons; it does not silently rewrite your prose. (One exception: a `create_note` tool the model can call to write a *new* note.)
- **Search is a conversation.** A query gets routed to a retrieval tier, context is assembled, and Claude answers with inline source citations. A traditional fuzzy-finder (⌘P) and full-text search dialog (⌘⇧F) exist alongside it.

UI is a three-panel workspace: file tree (left) · block editor (center) · AI chat (right, toggleable, drag-resizable). When no document is open, the center shows a **Dashboard**: Quick Notes widget + Todo widget on the left, today's Daily Document in the middle.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.1.6 (App Router), React 19.2, TypeScript |
| Styling | Tailwind CSS v4 |
| Block editor | BlockNote 0.47 (`@blocknote/core` + `/react` + `/mantine` + `/xl-multi-column`), ProseMirror under the hood |
| Client state | Zustand (`src/lib/store.ts`), single `useAppStore` |
| Database / auth / storage | Supabase (Postgres + pgvector + pg_trgm + Auth + Storage) |
| Chat LLM | Anthropic API direct (`@anthropic-ai/sdk`) — Haiku 4.5 / Sonnet 4.6 |
| Router + summarizer LLM | Groq `llama-3.1-8b-instant` |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) |
| Canvas | tldraw 4.5 (moodboard note type) |
| PDF | react-pdf / pdfjs |
| Files | Google Drive API (read-only scope) |
| Tables | TanStack Table (custom database block) |
| DnD | dnd-kit (sidebar tree reordering) |

**No Vercel AI SDK, no assistant-ui, no Yjs.** (`implementaiton.md` at the repo root is an early vision doc and is out of date on all three — trust this document and the code.)

Persistence is **not real-time/CRDT**. It is debounced autosave: editor change → 1s debounce → `saveDocument` → Supabase update. There is no multi-device conflict resolution. Last write wins on the whole `content` column. **This matters a lot for iOS** — see §11.

---

## 3. Data model

All tables live in the public schema of one Supabase project. Migrations are individual `.sql` files in `supabase/`, applied by hand in the SQL editor (there is no migration runner). `supabase/schema.sql` is the base; the rest are incremental.

### `documents` — the core table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `title` | text | default `'Untitled'` |
| `subtitle` | text null | |
| `folder_id` | uuid null → folders | `on delete set null` |
| `parent_document_id` | uuid null → documents | sub-pages / nesting |
| `user_id` | uuid → auth.users | default `auth.uid()` |
| `content` | text | **JSON-stringified BlockNote block array** (§4) |
| `tags` | text[] | user + system tags (dates, `"quick note"`) |
| `settings` | jsonb | `{ font?, fontSize?, fullWidth? }` per-note display settings |
| `doc_type` | text | `note` \| `todo` \| `daily_parent` \| `daily` \| `quick_note_parent` \| `moodboard` |
| `position` | integer | manual ordering within a parent |
| `share_slug` | text unique null | non-null ⇒ publicly readable at `/share/<slug>` |
| `fts` | tsvector generated | `title`(A) + `subtitle`(B) + `content`(C), GIN indexed |
| `ai_summary` | text null | LLM-generated document summary |
| `ai_tags` | text[] | LLM-generated tags from a controlled vocabulary |
| `embedding` | vector(1536) | embedding **of the summary**, not the raw content |
| `content_hash` | text null | sha256 of `content` — used to skip re-indexing |
| `index_status` | text | `idle` \| `processing` \| `indexed` \| `error` |
| `created_at` / `updated_at` | timestamptz | `updated_at` maintained by trigger |

Also indexed: `folder_id`, `parent_document_id`, `user_id`, `doc_type`, GIN on `tags` and `ai_tags`, GIN trigram on `title` and `content`.

Two partial unique indexes enforce singletons per user: one `todo` document and one `daily_parent` document.

### `folders`

`id`, `name`, `parent_id` (→ folders), `parent_document_id` (→ documents — folders can nest under a *document*, not just under folders), `user_id`, `position`, timestamps.

### `backlinks`

`source_document_id`, `target_document_id`, `user_id`, unique on the pair. Rebuilt on every save by `parseBacklinks()` + `syncBacklinks()`, which detect both `[[wikilink]]` text and `pageLink` inline nodes.

### `annotations` — inline AI threads on highlighted text

`id`, `document_id`, `user_id` (**text**, not uuid), `block_id`, `highlighted_text`, `messages` jsonb (`[{role, content, timestamp}]`), `summary`, `embedding` vector(1536), timestamps.

### `pdf_annotations` — highlights/notes/chats on Drive PDFs

`drive_file_id`, `user_id` (text), `color` (yellow|green|blue|pink|purple), `type` (highlight|note|chat), `page_number`, and a **text-quote anchor** (`anchor_exact`, `anchor_prefix` ~30 chars, `anchor_suffix` ~30 chars) so highlights relocate across sessions. Plus `note` text and `messages` jsonb.

### `attachments` + `user_google_tokens`

`attachments` links a document to a Google Drive file (`drive_file_id`, `file_name`, `mime_type`, `file_size`, `drive_web_view_link`).
`user_google_tokens` stores the Google **refresh token** per user so `/api/drive/token` can mint fresh access tokens server-side.

### `document_chunks` — the retrieval index

`document_id`, `chunk_index`, `content`, `content_hash`, `heading`, `block_ids` text[], `token_count`, `summary`, `tags` text[], `embedding` vector(1536).

### `usage_logs` — token accounting

`user_id`, `flow`, `provider`, `model`, `input_tokens`, `output_tokens`, `document_id`. Written fire-and-forget after every LLM call; aggregated by `/api/ai/usage`.

### `moodboard_state` / `moodboard_objects` / `moodboard_assets`

For `doc_type = 'moodboard'` documents: a tldraw snapshot keyed by `document_id`, plus a relational mirror of canvas objects and an asset registry backed by a public Supabase Storage bucket `moodboard-assets`.

### Postgres functions (callable via `supabase.rpc(...)`)

| Function | Purpose |
|---|---|
| `search_documents(search_query text)` | FTS with `ts_headline` snippet; **falls back to pg_trgm fuzzy match** when FTS returns 0 rows. Returns `id, title, subtitle, folder_id, tags, snippet, rank, created_at, updated_at`. Returns a short snippet, *not* full content (deliberate egress optimization). |
| `match_chunks(query_embedding, match_threshold, match_count)` | cosine similarity over `document_chunks` |
| `match_documents(query_embedding, match_threshold, match_count)` | cosine similarity over document summaries |
| `match_annotations(query_embedding, ...)` | cosine similarity over annotation threads |
| `get_all_tags()` | union of `documents.ai_tags` + `document_chunks.tags` — the controlled tag vocabulary |

> ⚠️ `search_documents` is `security definer` and **no longer filters by `auth.uid()`** — the trigram migration removed that filter so the service-role chat pipeline could use it. It returns rows across all users. Fine today (single user); a hazard the moment there are two.

---

## 4. The content format (read this before writing a single note)

`documents.content` is `JSON.stringify(blockArray)` where each block is a BlockNote block:

```json
[
  {
    "id": "6f1e…-uuid",
    "type": "heading",
    "props": { "level": 2, "textColor": "default", "backgroundColor": "default", "textAlignment": "left" },
    "content": [{ "type": "text", "text": "Tuesday, March 18, 2026", "styles": {} }],
    "children": []
  },
  {
    "id": "a24c…-uuid",
    "type": "paragraph",
    "props": { "textColor": "default", "backgroundColor": "default", "textAlignment": "left" },
    "content": [{ "type": "text", "text": "An idea I had.", "styles": {} }],
    "children": []
  }
]
```

**Block types in use:** all BlockNote defaults (`paragraph`, `heading`, `bulletListItem`, `numberedListItem`, `checkListItem`, `codeBlock`, `image`, `table`, `quote`, …), plus multi-column from `@blocknote/xl-multi-column`, plus one custom block:

- **`database`** — a Notion-style table. `content: "none"`, and `props.columns` / `props.rows` are **JSON strings** (double-encoded):
  ```json
  { "id": "qn-day-db-block", "type": "database",
    "props": { "columns": "[{\"id\":\"qn-day-title\",\"name\":\"Title\",\"type\":\"text\",\"width\":400,\"isTitle\":true}]",
               "rows": "[{\"id\":\"<docId>\",\"docId\":\"<docId>\",\"cells\":{\"qn-day-title\":\"My note\"}}]" },
    "children": [] }
  ```
  Column types: `text | number | select | checkbox | date`. Exactly one column has `isTitle: true`; a row with a `docId` renders as a link to that document.

**Inline content types:** BlockNote defaults plus one custom:

- **`pageLink`** — `{ "type": "pageLink", "props": { "docId": "...", "docTitle": "..." } }`, renders as a clickable pill. Titles are propagated on rename via `propagatePageLinkTitle()`.

**Text styles** live in `styles`: `{ "bold": true, "italic": true, "underline": true, "strike": true, "code": true, "textColor": "...", "backgroundColor": "..." }`.

**Converters that already exist in the repo:**

- `src/lib/blocksToMarkdown.ts` → `blocksToMarkdown(contentJson)` (exported).
- `src/lib/ai/context.ts` → `blocksToPlainText(contentJson)` (exported).
- `src/lib/ai/tools.ts` → `markdownToBlockNote(md)` — **private, not exported**. Handles headings, paragraphs, bullets, numbered lists, checklists, code fences, bold/italic/inline-code/strikethrough/links. If you want an iOS client to POST markdown and have the server convert it, this function needs to be lifted into a shared module (e.g. `src/lib/markdownToBlocks.ts`) and exported. **Recommended** — do not reimplement markdown→BlockNote in Swift.

The minimum viable write from a client that only has plain text: one `paragraph` block per line, `id` = a fresh UUID, `props` as above, `styles: {}`. BlockNote tolerates missing props by filling defaults, but supply them anyway.

---

## 5. Auth, RLS, and the security posture

**Auth:** Supabase Auth, Google OAuth only, with `access_type=offline&prompt=consent` and the `drive.readonly` scope. On every auth state change the client upserts `provider_refresh_token` into `user_google_tokens`. The web client uses `@supabase/ssr`'s `createBrowserClient` (cookie-backed session).

For iOS: use the Supabase Swift SDK with the **same** Supabase project URL + anon key and `signInWithOAuth(provider: .google)`. The resulting `user.id` is the same uuid the web app writes as `documents.user_id`, so data lines up automatically. Request the Drive scope only if the iOS app needs Drive.

**RLS status — uneven, know this:**

| Table | RLS |
|---|---|
| `documents` | ✅ enabled, 4 policies scoped to `auth.uid() = user_id`, **plus** a public-select policy for rows where `share_slug IS NOT NULL` |
| `folders` | ✅ enabled, per-user |
| `backlinks` | ✅ enabled, per-user |
| `annotations` | ❌ policies are commented out in the migration |
| `pdf_annotations`, `attachments`, `user_google_tokens` | ❌ no RLS |
| `document_chunks`, `usage_logs` | ❌ no RLS |
| `moodboard_*` | ❌ policies commented out |
| Storage bucket `moodboard-assets` | public read |

**API routes have no auth check at all** — except `/api/drive/token`, which validates a Supabase bearer token. `/api/ai/chat`, `/api/ai/index`, `/api/ai/backfill`, `/api/ai/annotate`, `/api/ai/usage` are open, run with the **service-role key**, and read/write across the whole table without a user filter. `create_note` even resolves the owner by grabbing `user_id` from an arbitrary sample row.

This is a deliberate single-user simplification, not an oversight to route around silently. **If the iOS app calls these endpoints over the public internet, they are open endpoints that spend the owner's Anthropic/OpenAI/Groq credits.** Recommended hardening before iOS ships is in §10.

---

## 6. Feature map (what the web app does today)

**Editing & organization**
- BlockNote editor with slash menu, drag handles, multi-column layouts.
- Folder tree with drag-and-drop reordering; documents nest under folders *or* under other documents; folders can also nest under documents.
- Tabs (`TabBar`), navigation history (back/forward), per-note display settings (font, size, full-width).
- Custom **database block**: inline Notion-style tables where each row can be a real document.
- **Moodboard** note type: full tldraw canvas with image/gif/video assets in Supabase Storage.
- **Notion import** (`NotionImport.tsx`, ~870 lines) — parses a Notion export into the folder/document tree. *The component still exists but is currently not mounted in `page.tsx`.*
- **Public share links**: toggle → 8-char slug → `/share/<slug>` renders read-only, resolving `pageLink`s to other shared docs where available.

**Search & navigation**
- ⌘P fuzzy command palette (open by title).
- ⌘⇧F full-text search dialog → `search_documents` RPC with snippet highlighting and trigram fallback for typos.
- Backlinks panel per document; `[[wikilink]]` and `pageLink` both feed the graph.

**Files**
- Google Drive folder browser in the sidebar; PDFs open in an in-app viewer.
- PDF highlighting with 5 colors, sticky notes, and per-highlight AI chat threads, anchored by text-quote (prefix/exact/suffix) so they survive re-renders.

**Dashboard (shown when no doc is open)**
- Quick Notes capture box + today's list.
- Todo widget (checklist blocks in the singleton `todo` document).
- Today's Daily Document preview.

**AI**
- Right-hand chat panel with tier badge, model selector (Auto / Claude Haiku / Claude Sonnet), "Research mode" toggle (forces `GENERAL`), "Look deeper" escalation button (forces `TIER2`), context chips (@-mention documents or blocks), inline `[n]` source citations.
- Highlight-to-annotate: select text → AI thread anchored to that block.
- Settings modal includes a **cost dashboard** from `usage_logs`.

---

## 7. The AI subsystem

### 7.1 Indexing pipeline (`src/lib/ai/indexDocument.ts`)

Triggered by `POST /api/ai/index` — the editor fires it **30 seconds after the last save**, debounced.

```
fetch doc → sha256(content) vs content_hash → skip if unchanged
  → blocksToChunks()            structure-aware, target 300–500 tokens/chunk,
                                headings create boundaries, lists stay whole
  → diff chunks by content_hash: keep / reprocess / delete
  → summarizeChunk()            Groq llama-3.1-8b-instant, returns {summary, tags}
                                (tags constrained by get_all_tags() vocabulary)
  → embedTexts()                OpenAI text-embedding-3-small, batched 100/call
  → write document_chunks
  → summarizeDocument() + tagDocument()   (Groq) → embed the doc summary
  → documents.{ai_summary, ai_tags, embedding, content_hash, index_status='indexed'}
```

Incremental by design: unchanged chunks are never re-summarized or re-embedded. `POST /api/ai/backfill` re-runs it over everything (sequentially, to dodge rate limits), with `{force: true}` clearing hashes and chunks first.

`src/lib/ai/groqLimiter.ts` wraps Groq calls in a concurrency/rate limiter.

### 7.2 Query routing (`src/lib/ai/router.ts`)

Three layers, cheapest first:

1. **Affirmation resolution** — a bare "yes"/"ok"/"do it" inherits the last substantive user query, so follow-ups route correctly instead of embedding the word "yes".
2. **Regex heuristics** — instant, no API call. Patterns force `TIER1` ("according to my notes"), `TIER2` ("across all my notes"), `TIER0` ("summarize this"), or `GENERAL` ("who was X"). Any context chips present ⇒ `CONTEXT`. No document open ⇒ `TIER1`.
3. **Groq classifier** — `llama-3.1-8b-instant`, 4-token output, only for the ambiguous remainder. Falls back to `TIER1` on error.

### 7.3 Retrieval tiers

| Tier | Retrieval | Typical query |
|---|---|---|
| `TIER0` | Current document only | "summarize this", "fix the intro" |
| `TIER1` | **Hybrid**: vector `match_chunks` (threshold 0.4, ≤25, ≤5/doc) ∥ `search_documents` keyword, merged, then `rerankChunks()` (similarity + term overlap + source signal) → top 20 chunks | "what have I written about X" |
| `TIER2` | Hybrid at doc level: vector docs + keyword docs, targeting ~7 **full** documents | "synthesize my views on X across everything" |
| `CONTEXT` | Only the explicitly @-mentioned documents/blocks; client ships the content so RLS never blocks it | "compare these two" |
| `GENERAL` | **No retrieval** — Claude answers from training data | "explain quantum entanglement" |

Model selection: `selectModel(contextTokens)` → Haiku 4.5 under 10k tokens, Sonnet 4.6 above. Overridable from the UI.

### 7.4 Agentic tools (`src/lib/ai/tools.ts`, ~2.4k lines)

Claude gets 27 tools in every chat turn, executed in parallel per round, max 5 rounds, with a ~35k-token input budget after which it's told to answer with what it has:

`search_notes` · `search_document_content` · `search_by_tags` · `search_by_date` · `get_document_info` · `batch_get_document_info` · `read_document_content` · `get_document_lengths` · `get_document_children` · `get_document_hierarchy` · `list_folder_contents` · `get_folder_tree` · `get_folder_info` · `get_backlinks` · `get_orphan_documents` · `get_chunk_summaries` · `find_similar_documents` · `compare_documents` · `get_recent_documents` · `get_recently_modified` · `get_writing_stats` · `count_documents` · `get_all_tags` · `get_tag_graph` · `get_annotations` · `get_daily_note` · **`create_note`**

`create_note(title, markdown, tags?, folderName?)` is the only writer. `folderName` accepts a single name (fuzzy, case-insensitive) or a `"A > B > C"` path.

### 7.5 Cost model

Every call logs to `usage_logs`. `/api/ai/usage?days=N` aggregates by flow/day/model and estimates USD with a hardcoded price table. Flows seen in the data: `chat-tier0|tier1|tier2|context|general`, `chat-route`, `annotate`, `index-summarize-chunk`, `index-summarize-doc`, `index-tag-doc`, `index-embed-chunks`, `index-embed-doc`.

Rough per-unit costs baked into the dashboard: Haiku 4.5 $0.80/$4.00 per M in/out, Sonnet 4.6 $3.00/$15.00, llama-3.1-8b $0.05/$0.08, embeddings $0.02.

---

## 8. HTTP API reference

All under the deployed origin. **Only `/api/drive/token` checks auth.**

### `POST /api/ai/chat` → SSE stream

```jsonc
// request
{
  "messages": [{ "role": "user" | "assistant", "content": "string" }],
  "activeDocumentId": "uuid | null",
  "activeDocumentContent": "BlockNote JSON string (optional — avoids a DB round-trip)",
  "contextItems": [
    { "type": "document", "docId": "uuid", "title": "…", "content": "optional JSON string" },
    { "type": "block", "blockId": "…", "text": "…", "docTitle": "…" }
  ],
  "tier": "TIER0|TIER1|TIER2|CONTEXT|GENERAL",  // optional override
  "modelOverride": "Claude Haiku | Claude Sonnet" // optional
}
```

Response is `text/event-stream`, each line `data: {json}\n\n`:

| `type` | Payload |
|---|---|
| `meta` | `{ tier, model, documentIds, sourceMap }` — sent first |
| `text` | `{ content }` — token delta |
| `tool_use` | `{ tool }` — name of a tool about to run (for a "searching your notes…" indicator) |
| `doc_created` | `{ docId, title }` — `create_note` fired; refresh your list |
| `done` | `{ tier, model, documentIds, sourceMap }` |
| `error` | `{ content }` |

`sourceMap` is `{ 1: {docId, title, chunkIndex?}, 2: {…} }`, mapping the `[n]` citations in the text.

`maxDuration` 120s, Node runtime.

### `POST /api/ai/annotate` → SSE stream

`{ annotationId, documentId, highlightedText, messages }` → streams `text` / `done` / `error`. Always Haiku 4.5, 1024 max tokens. Fetches ~4k chars of surrounding document text for context. After 2+ messages it embeds the thread into `annotations.{summary, embedding}` so annotations become searchable.

### `POST /api/ai/index`

`{ documentId }` → `{ status: "skipped"|"indexed"|"error", documentId, chunksTotal, chunksNew, chunksKept, chunksDeleted, error? }`.

### `POST /api/ai/backfill`

`{ force?: boolean, limit?: number, documentIds?: string[] }` → `{ status, processed, succeeded, failed, results[] }`. `maxDuration` 300s.

### `GET /api/ai/usage?days=30`

→ `{ days, totalCalls, totalInput, totalOutput, totalCostUsd, byFlow, byDay, byModel, costByModel }`.

### `GET /api/share/[slug]`

Public. → `{ title, subtitle, content, settings, tags, updatedAt, createdAt, pageLinkMap }`.

### `POST /api/drive/token`

Requires `Authorization: Bearer <supabase access token>`. Exchanges the stored Google refresh token for a fresh access token → `{ access_token, expires_in }`.

---

## 9. Quick Notes, Daily Notes, Todo — the capture system

This is the part the iOS app should plug into.

### Quick Notes hierarchy

```
"Quick Notes"  (doc_type = 'quick_note_parent', singleton)
  └── "Tuesday, March 18, 2026"  (doc_type = 'note', tags = ['2026-03-18'])
        ├── "buy milk"    (doc_type = 'note', tags = ['quick note'])
        └── "app idea…"   (doc_type = 'note', tags = ['quick note'])
```

Relevant functions in `src/lib/db.ts`:

- `ensureQuickNoteParentDocument()` — finds/creates the singleton by `doc_type`.
- `ensureTodayQuickNoteContainer()` — finds/creates today's day container, tagged `YYYY-MM-DD`.
- `createQuickNote(title)` — creates the note (body starts empty, `"[]"`), tags it `"quick note"`, then calls `syncQuickNoteDatabases()`.
- `fetchTodayQuickNotes()` — children of today's container, newest first.

**The title *is* the idea.** The capture box writes the whole typed string into `title` and leaves `content` as `"[]"`. That's the existing UX; an iOS app can follow it, or write a real body and keep the title as a short label.

`syncQuickNoteDatabases(parentId, dayContainerId?)` rebuilds the **database blocks** inside the parent and day containers so they list the notes. If the iOS app inserts a document row directly via Supabase, the note appears in the sidebar tree immediately (that's derived from `parent_document_id`) but the table views stay stale until the web app calls the sync. Options: (a) have iOS replicate the block-rebuild (it's just two JSON string props), (b) accept staleness and let the next web-side capture resync, or (c) add a server route that does it (recommended, see §10).

### Daily documents

```
"Daily Documents" (doc_type = 'daily_parent', singleton)
  └── "Tuesday, March 18, 2026" (doc_type = 'daily', tags = ['2026-03-18'])
```

`ensureTodayDailyDocument()` creates today's note with a heading + placeholder paragraph and calls `syncDailyParentDatabase()`. The AI can read it via the `get_daily_note` tool. This is the natural target for "rapid summaries" — an iOS-generated daily digest could be appended here.

### Todo

One singleton document, `doc_type = 'todo'`. The widget reads and writes `checkListItem` blocks in its `content` — `{ blockId, text, checked }`. Toggling a checkbox rewrites the whole content JSON.

---

## 10. Integrating the iOS app — recommended path

### Option A: direct Supabase from iOS (recommended for capture + reads)

Use the Supabase Swift SDK with the same project URL and anon key.

**Wins:** RLS already protects `documents`/`folders`; offline queueing is yours to control; no server round-trip; no new endpoints. Realtime subscriptions are available if you want the web app to see captures live.

**You must handle in Swift:**
1. Google OAuth sign-in via Supabase (same identity as web).
2. BlockNote JSON emission (§4) — or send markdown to a server route (Option B) and let the existing converter do it.
3. The Quick Notes hierarchy lookups (`doc_type` singleton → date-tagged container → insert child) — ~40 lines mirroring `db.ts`.
4. `POST /api/ai/index` after writing, so the note becomes searchable in the web app's AI chat. Without this, a note captured on iOS is invisible to vector retrieval (it will still surface via keyword/trigram search, which reads `documents.content` directly).

**Timezone gotcha:** the date tag uses `new Date().toISOString().slice(0,10)` (**UTC**) while the container *title* uses `toLocaleDateString` (**local**). Late-evening captures in a negative-UTC-offset timezone land in tomorrow's UTC bucket. Match the existing UTC behavior for the tag so iOS and web agree on the same container, and consider fixing both sides together rather than only one.

### Option B: add mobile-facing API routes (recommended for AI + writes)

Add to the Next.js app (this repo), keeping iOS thin:

```
POST /api/mobile/quick-note   { text, markdown? } → creates note in today's container,
                                                    runs syncQuickNoteDatabases, triggers indexing
POST /api/mobile/summarize    { scope: 'today'|'week'|'docIds', ... } → streamed summary
GET  /api/mobile/today        → today's quick notes + daily note + todo state
```

Each should:
- Require `Authorization: Bearer <supabase access token>`, verify with `anonClient.auth.getUser(token)` (the pattern already in `/api/drive/token`), and use the resolved `user.id` as `user_id` instead of the "grab a sample row" hack in `create_note`.
- Reuse `markdownToBlockNote` — **export it from `tools.ts` into a shared module first**.

For "rapid summaries", the cheapest correct thing is to call the existing `POST /api/ai/chat` with `tier: "TIER1"` or `"TIER2"` and parse the SSE stream; `URLSession.bytes(for:)` handles this cleanly in Swift. Note the `sourceMap` so you can render citations.

### Hardening to do before iOS ships (in this repo, not the iOS one)

1. **Add bearer-token auth to `/api/ai/*`.** They currently run service-role with no user filter and no rate limit; a mobile app makes their URLs discoverable.
2. **Scope retrieval by `user_id`.** `match_chunks`, `match_documents`, `match_annotations`, and `search_documents` all ignore the user. Add a `p_user_id uuid` parameter.
3. **Enable RLS on `annotations`, `pdf_annotations`, `attachments`, `document_chunks`, `moodboard_*`** — the policies are already written as comments in the migrations.
4. Note that `annotations.user_id` and `pdf_annotations.user_id` are **text**, while `documents.user_id` is **uuid**. Unify before writing to them from a second client.

---

## 11. Sharp edges

- **Last-write-wins on `content`.** Autosave PUTs the entire block array. If iOS and web have the same document open, one silently clobbers the other. For a capture app this is mostly fine (new docs, no concurrent edit) — but never have iOS write to a document the user may have open in the browser without a merge story. Prefer append-by-creating-a-new-child-note over editing an existing body.
- **Indexing is a 30s-debounced client-side `fetch`.** Nothing indexes server-side on write. A note created outside the web editor is *never* indexed unless something explicitly calls `/api/ai/index`.
- **Documents are indexed by summary, not raw text.** `documents.embedding` embeds `ai_summary`. If indexing hasn't run, semantic search can't see the note at all; keyword/trigram search still can.
- **`content_hash` gates re-indexing.** Change `content` without clearing the hash and the pipeline still re-runs (the hash is recomputed from content), but forcing a rebuild of *unchanged* docs requires `{force: true}` on backfill.
- **The `database` block reads `props.data` in the chunker but is written as `props.columns`/`props.rows`.** So table contents currently contribute nothing to chunk text (`src/lib/ai/chunker.ts` — dead branch). If tables matter to iOS summaries, fix the chunker.
- **`doc_type` singletons are enforced by partial unique index.** Creating a second `todo` or `daily_parent` fails at the DB. Always go through the `ensure*` pattern.
- **Two `user_id` type systems** (uuid on documents/folders/backlinks, text on annotations/pdf_annotations/attachments/usage_logs).
- **`usage_logs.user_id` defaults to the literal string `'local'`** — server-side logging never attributes to a real user.
- **No migration runner.** New tables/functions require pasting SQL into the Supabase dashboard, in order. `search_documents` has been redefined four times; `supabase/trigram_search_migration.sql` is the current one.
- **Egress is a live concern.** The sidebar cache deliberately strips `content`, and `search_documents` returns snippets instead of full documents, after a Supabase egress problem. Don't have iOS `select('*')` over `documents` on a timer.

---

## 12. Environment

Required env vars (`.env.local` locally, Vercel project env in prod):

```
NEXT_PUBLIC_SUPABASE_URL         # also what iOS needs
NEXT_PUBLIC_SUPABASE_ANON_KEY    # also what iOS needs
SUPABASE_SERVICE_ROLE_KEY        # server-only — never ship to a mobile binary
ANTHROPIC_API_KEY                # chat + annotation
OPENAI_API_KEY                   # embeddings
GROQ_API_KEY                     # router + summarization
GOOGLE_CLIENT_ID                 # Drive token exchange
GOOGLE_CLIENT_SECRET             # Drive token exchange
```

`getServerSupabase()` falls back to the anon key when the service-role key is missing, and warns; RLS then blocks most server operations.

Commands: `npm run dev` · `npm run build` · `npm run start` · `npm run lint`.

---

## 13. Where things live

```
src/app/
  page.tsx                    three-panel shell, ⌘P / ⌘⇧F shortcuts
  api/ai/{chat,annotate,index,backfill,usage}/route.ts
  api/drive/token/route.ts
  api/share/[slug]/route.ts
  share/[slug]/               public read-only view
src/lib/
  db.ts          (2.1k)       all Supabase data access + system-doc helpers
  store.ts       (1.2k)       Zustand store, localStorage cache layer
  types.ts                    every DB + client type — start here
  supabase.ts / supabaseServer.ts
  auth.tsx                    AuthProvider, Google OAuth, Drive token persistence
  editorSchema.ts             BlockNote schema (database block + pageLink + multi-column)
  pageLink.tsx / databaseBlock.tsx / databaseTypes.ts
  blocksToMarkdown.ts
  pdfAnchor.ts                text-quote anchoring for PDF highlights
  googleDrive.ts
  ai/
    router.ts                 tier routing
    retrieve.ts    (582)      hybrid retrieval + rerank
    context.ts     (372)      prompt assembly per tier, model selection
    tools.ts       (2.4k)     27 tool definitions + executors
    indexDocument.ts          indexing orchestrator
    chunker.ts / embed.ts / summarize.ts / usage.ts / groqLimiter.ts
src/components/               Sidebar, EditorPanel, DocumentEditor, ChatPanel,
                              Dashboard, QuickNoteWidget, TodoWidget, FileViewer, …
supabase/*.sql                hand-applied migrations
plan/                         design docs for the AI integration, database block, moodboard
implementaiton.md             ⚠️ outdated vision doc — prefer this file
```

**Best files to read first, in order:** `src/lib/types.ts` → `supabase/schema.sql` + `supabase/ai_migration.sql` → `src/lib/db.ts` (Quick Notes section, ~line 1800) → `src/app/api/ai/chat/route.ts`.
