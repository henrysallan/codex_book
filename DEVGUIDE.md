# Cortex — Developer Guide

**Read this first.** It is the orientation document for any agent or developer working in this repo.
For deeper detail on the data model and HTTP surface, see [docs/cortex-architecture-for-ios.md](docs/cortex-architecture-for-ios.md).
Ignore [implementaiton.md](implementaiton.md) — it is an out-of-date vision doc (it names libraries this project does not use).

---

## 1. What this is

Cortex (package name `cortex`, app title "Codex") is a **single-user, document-first personal knowledge base**: a Notion-style block editor over Supabase Postgres, with a Claude-powered chat panel that retrieves from a pgvector index of the user's own notes.

Three design commitments that explain most of the code:

- **The document is the primary artifact** — not a row, not a chat thread. Everything (todos, daily notes, quick notes, moodboards, database tables) is a `documents` row with a different `doc_type`.
- **AI lives beside the document, never inside it.** The chat panel reads and reasons; it does not silently rewrite prose. The one exception is the `create_note` tool, which writes a *new* note.
- **Search is a conversation.** Queries are routed to a retrieval tier, context is assembled, Claude answers with inline citations. Classic ⌘P fuzzy-find and ⌘⇧F full-text search exist alongside it.

**UI shape:** three panels — sidebar tree (left) · block editor (center) · AI chat (right, toggleable + drag-resizable). With no document open, the center shows the Dashboard (quick notes, todos, today's daily note).

---

## 2. Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.1.6 App Router, React 19.2, TypeScript strict |
| Styling | Tailwind CSS v4 (`@import "tailwindcss"`, CSS-var theme in [globals.css](src/app/globals.css)) |
| Editor | BlockNote 0.47 (`core` + `react` + `mantine` + `xl-multi-column`), ProseMirror underneath |
| Client state | Zustand — one store, [src/lib/store.ts](src/lib/store.ts) |
| DB / auth / storage | Supabase (Postgres + pgvector + pg_trgm + Auth + Storage) |
| Chat LLM | Anthropic SDK direct — Haiku 4.5 / Sonnet 4.6 |
| Router + summarizer | Groq `llama-3.1-8b-instant` |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) |
| Extras | tldraw (moodboards), react-pdf (PDF viewer), TanStack Table (database block), dnd-kit (sidebar DnD) |

**Not used:** Vercel AI SDK, assistant-ui, Yjs/CRDT, any ORM. Talk to Supabase directly.

---

## 3. Running it

```bash
npm run dev      # next dev
npm run build    # next build
npm run lint     # eslint
```

No test suite exists. Verify changes by running the app.

`.env.local` (all required for full functionality):

```
NEXT_PUBLIC_SUPABASE_URL=        # client + server
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # browser client (RLS enforced)
SUPABASE_SERVICE_ROLE_KEY=       # server routes only (RLS bypassed)
ANTHROPIC_API_KEY=               # chat + annotations
OPENAI_API_KEY=                  # embeddings
GROQ_API_KEY=                    # query router + chunk summaries
GOOGLE_CLIENT_ID=                # Drive token exchange
GOOGLE_CLIENT_SECRET=
```

The app degrades rather than crashes when Supabase is unconfigured (`isSupabaseConfigured()` gates auth and store init).

---

## 4. Directory map

```
src/app/
  page.tsx                 3-panel shell, auth gate, ⌘P handler, chat resize
  layout.tsx               AuthProvider + Inter font
  globals.css              theme vars + BlockNote/table/tldraw overrides
  api/ai/{chat,annotate,index,backfill,usage}/route.ts
  api/drive/token/route.ts, api/share/[slug]/route.ts
  share/[slug]/            public read-only document view
src/components/            all UI, named exports, "use client"
  database/                database-block cell editor + column menu
src/lib/
  store.ts    (1.2k)       Zustand store — the single source of client truth
  db.ts       (2.1k)       every Supabase query lives here
  types.ts                 Db* (snake_case rows) + client-side camelCase types
  graph/                   full-database node graph (build, worker layout, canvas renderer)
  auth.tsx                 AuthProvider / useAuth, Google OAuth + Drive scope
  supabase.ts              browser client (anon key)
  supabaseServer.ts        server client (service role) — never import client-side
  editorSchema.ts          BlockNote schema: default blocks + database + pageLink
  pageLink.tsx             custom inline content (page mention pill)
  databaseBlock.tsx        custom block wrapping DatabaseTable
  ai/                      chunker, embed, summarize, router, retrieve, context,
                           indexDocument, tools (2.4k), usage, groqLimiter
supabase/*.sql             hand-run migrations (see §8)
plan/, docs/               design specs and the iOS integration guide
```

---

## 5. The two rules that break things if ignored

### 5.1 `documents.content` is BlockNote JSON, not markdown

It is a `text` column holding a **JSON-stringified array of BlockNote block objects**. Writing plain text or markdown into it renders as garbage in the editor. Minimal valid body:

```json
[{"id":"<uuid>","type":"paragraph","props":{},"content":[{"type":"text","text":"hello","styles":{}}],"children":[]}]
```

To go the other way, use [blocksToPlainText](src/lib/ai/context.ts) — that is what every AI/server path uses. ([blocksToMarkdown.ts](src/lib/blocksToMarkdown.ts) also exists but is currently imported nowhere.) Never `JSON.parse` content inline in a component — it may already be parsed.

### 5.2 All DB access goes through `src/lib/db.ts`, all client state through `src/lib/store.ts`

Components never call `supabase.from(...)` directly. The flow is:

```
component → useAppStore action → db.ts function → Supabase
                ↓
        _dbFolders / _dbDocuments (raw rows in store)
                ↓
        _rebuildTree() → folders / rootDocuments (tree for sidebar)
                ↓
        persistSidebarCache() → localStorage (cortex:cache:*)
```

`initialize()` is **cache-first**: it paints from localStorage instantly, then revalidates from Supabase. After a local mutation call `_rebuildTree()` — do **not** re-run `initialize()`, which forces a full refetch.

---

## 6. Editor & persistence

[DocumentEditor.tsx](src/components/DocumentEditor.tsx) owns one BlockNote instance per document (`key={document.id}` forces remount on switch). On every change:

1. **1s debounce** → `saveDocument(id, { content })` → Supabase update.
2. Then `parseBacklinks` + `syncBacklinks` (handles both `[[wikilinks]]` and `pageLink` inline nodes).
3. Then a **30s debounce** → `POST /api/ai/index` to re-embed the document.

There is **no CRDT and no conflict resolution** — last write wins on the whole `content` column. Two open tabs on the same doc will clobber each other.

Sync state is surfaced via a local `syncStatus` (`pending | saving | synced | error`).

---

## 7. The AI subsystem

### Indexing ([src/lib/ai/indexDocument.ts](src/lib/ai/indexDocument.ts))

`chunk → diff by content_hash → summarize/tag new chunks (Groq) → embed (OpenAI) → doc-level summary/tags/embedding → update index_status`.
Chunking follows document structure (headings are boundaries, target 300–500 tokens). Unchanged chunks are kept, so re-indexing an edited note is cheap. `POST /api/ai/backfill` re-indexes everything (`{ force, limit, documentIds }`).

### Routing ([src/lib/ai/router.ts](src/lib/ai/router.ts))

Three layers, in order: **affirmation resolution** (a bare "yes" inherits the last substantive query) → **regex heuristics** → **Groq 8B classifier** (~1 token out). Output is a tier:

| Tier | Meaning | Retrieval |
|---|---|---|
| `TIER0` | About the open document | current doc content only |
| `TIER1` | Cross-document search | hybrid vector + keyword chunks, reranked, ≤20 |
| `TIER2` | Deep synthesis | full text of ~7 documents |
| `CONTEXT` | User pinned docs/blocks | exactly those items |
| `GENERAL` | Research question, no notes | no retrieval — Claude's own knowledge |

`CONTEXT` wins whenever context items exist. The "Look deeper" button in the chat panel force-overrides to `TIER2`.

### Chat ([src/app/api/ai/chat/route.ts](src/app/api/ai/chat/route.ts))

`route → retrieve → assemble system prompt → select model → stream`. Model choice is by context size (`selectModel`: <10k tokens → Haiku, else Sonnet), overridable from the UI.

Response is **SSE** with typed events: `meta` (tier, model, documentIds, sourceMap) → `tool_use` → `text`… → `done`, or `error`. There is an agentic tool loop of up to **5 rounds** over ~27 tools defined in [tools.ts](src/lib/ai/tools.ts) (`search_notes`, `read_document_content`, `get_backlinks`, `create_note`, …), with a ~35k input-token budget that forces a final answer when exceeded.

Every LLM call ends in `logUsage()` → `usage_logs` (fire-and-forget, never throws). All Groq calls must go through `groqLimited()` — a serial queue with a 2.5s gap and 429 backoff to stay under the free-tier 30 RPM.

---

## 8. Database

Migrations are **plain SQL files run by hand in the Supabase SQL editor**. There is no migration runner and no ordering metadata — start with `schema.sql`, then `auth_migration.sql`, then the feature migrations. Adding a column means writing a new `*_migration.sql` file *and* updating the `Db*` interface in [types.ts](src/lib/types.ts).

Key tables: `documents` (the core), `folders`, `backlinks`, `document_chunks` (pgvector index), `annotations`, `pdf_annotations`, `attachments`, `user_google_tokens`, `usage_logs`, `moodboard_*`.

Postgres functions callable via `supabase.rpc(...)`: `search_documents` (FTS + trigram fallback), `match_chunks`, `match_documents`, `match_annotations`, `get_all_tags`.

**Security posture, stated plainly:** RLS is enabled only on `documents`, `folders`, and `backlinks` (per `user_id`), plus a public-read policy for rows with a `share_slug`. Every other table is unprotected, and the `/api/ai/*` routes are **unauthenticated and service-role-backed** — they are effectively single-tenant. Assume that when adding routes; do not treat these endpoints as safe to expose more widely without adding auth.

---

## 9. Conventions

- **Components:** `"use client"` at the top, named exports (`export function Foo()`), props typed inline or via a local `FooProps` interface. Only `MoodboardCanvas` also has a default export (for `next/dynamic`).
- **Heavy components** (`FileViewer`, `MoodboardCanvas`) are loaded with `next/dynamic` + `ssr: false`.
- **Types:** DB rows are snake_case `DbDocument`/`DbFolder`; client types are camelCase `Document`/`Folder`. Convert at the `db.ts` boundary (`dbDocumentToDocument`).
- **Styling:** Tailwind utility classes with semantic theme tokens — `bg-sidebar-bg`, `border-border`, `text-muted-foreground`. Third-party widget overrides (BlockNote, tables, tldraw) go in `globals.css`, not inline.
- **Icons:** `lucide-react`, typically `size={14}`/`size={16}`.
- **Store selectors:** subscribe narrowly — `useAppStore((s) => s.activeDocument)` — never destructure the whole store.
- **API routes:** `export const runtime = "nodejs"` and an explicit `maxDuration`; log with a `[/api/...]` prefix; return `NextResponse.json({ error }, { status })` on failure.
- **Errors:** background work (usage logging, indexing, backlink sync, cache writes) fails silently or with `console.warn` — never break the user's save path.
- Comments use `// ─── Section ───` dividers; match the surrounding density.

---

## 10. Sharp edges

- **`documents.content` shape** — see §5.1. The single most common way to corrupt data here.
- **Cache staleness** — the sidebar renders from localStorage before the network responds. If a tree change doesn't appear, you probably mutated `_dbDocuments` without calling `_rebuildTree()`.
- **Special `doc_type` documents** (`todo`, `daily_parent`, `daily`, `quick_note_parent`, `moodboard`) are created lazily by `ensure*Document()` helpers in `db.ts`. Never hand-create these rows; reuse the helpers or you'll get duplicates.
- **Groq rate limit** — any new Groq call must be wrapped in `groqLimited()`.
- **Service role key** — `supabaseServer.ts` must never be imported from a client component. It silently falls back to the anon key if the service key is missing, which surfaces as confusing RLS failures.
- **Drive access** requires the Google refresh token stored at sign-in (`user_google_tokens`); `/api/drive/token` exchanges it server-side so the client secret never ships to the browser.
- **PDF worker** — `canvas` is aliased away in both the Turbopack and webpack configs in [next.config.ts](next.config.ts). Don't remove either alias.
- **Shortcuts:** ⌘P command palette ([page.tsx](src/app/page.tsx)), ⌘⇧F search dialog ([SearchBar.tsx](src/components/SearchBar.tsx)).

---

## 11. Where to work

| Task | Start here |
|---|---|
| Sidebar tree, DnD, folder ops | [Sidebar.tsx](src/components/Sidebar.tsx), `buildFolderTree` in [db.ts](src/lib/db.ts) |
| Editor behavior, slash menu, autosave | [DocumentEditor.tsx](src/components/DocumentEditor.tsx) |
| New block or inline content type | [editorSchema.ts](src/lib/editorSchema.ts) + a spec like [pageLink.tsx](src/lib/pageLink.tsx) |
| Chat UI, citations, "Look deeper" | [ChatPanel.tsx](src/components/ChatPanel.tsx), [Markdown.tsx](src/components/Markdown.tsx) |
| Retrieval quality | [retrieve.ts](src/lib/ai/retrieve.ts), [context.ts](src/lib/ai/context.ts), [router.ts](src/lib/ai/router.ts) |
| New AI capability | add to `TOOL_DEFINITIONS` + `executeTool` in [tools.ts](src/lib/ai/tools.ts) |
| Indexing / chunking | [indexDocument.ts](src/lib/ai/indexDocument.ts), [chunker.ts](src/lib/ai/chunker.ts) |
| Any new persisted field | migration SQL + [types.ts](src/lib/types.ts) + [db.ts](src/lib/db.ts) + [store.ts](src/lib/store.ts) |
| Graph view | [GraphView.tsx](src/components/GraphView.tsx), `src/lib/graph/` |
| Public sharing | [share/[slug]/](src/app/share/[slug]/), [shareSchema.tsx](src/lib/shareSchema.tsx) |
