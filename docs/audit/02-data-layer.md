# 02 — Data Layer & Persistence

**Finding IDs:** `DATA-C1` … `DATA-L9`. Referenced elsewhere as "Data C1", etc.
**Scope:** `db.ts` (2088 ln), `store.ts` (1172 ln), `types.ts`, `databaseTypes.ts`,
`blocksToMarkdown.ts`, all 16 `supabase/*.sql` migrations. Plus grep sweeps for direct Supabase
access outside `db.ts`.

---

## 1. SPEC

### 1.1 Effective data model (after all migrations, in intended order)

**folders**: `id` uuid PK · `name` · `parent_id`→folders **CASCADE** · `parent_document_id`→documents
**SET NULL** · `user_id` uuid NOT NULL default `auth.uid()` FK auth.users CASCADE · `position` int ·
`created_at`/`updated_at` nullable. Indexes on parent_id, user, parent_document_id. **RLS on**, 4
own-row policies.

**documents**: `id` · `title` default 'Untitled' · `subtitle` · `folder_id`→folders **SET NULL** ·
`parent_document_id`→documents **SET NULL** · `user_id` uuid NOT NULL default auth.uid() ·
`content` text NOT NULL default '[]' (JSON-stringified BlockNote blocks) · `tags` text[] ·
`settings` jsonb · `position` int · `fts` tsvector GENERATED (title A + subtitle B + content C)
STORED · `doc_type` text default 'note' (**no CHECK**) · `share_slug` unique · `ai_summary` ·
`ai_tags` text[] · `embedding` vector(1536) · `content_hash` · `index_status` default 'idle' ·
`created_at`/`updated_at`. Indexes: folder_id, parent_document_id, tags GIN, fts GIN, user, doc_type,
**partial UNIQUE (user_id) WHERE doc_type='todo'** and `='daily_parent'`, share_slug partial, ai_tags
GIN, title/content trigram GIN. IVFFlat embedding indexes **commented out**. **RLS on**, 4 own-row
policies + `Public read for shared documents USING (share_slug IS NOT NULL)`.

**backlinks**: id · source/target →documents **CASCADE** · UNIQUE(source,target) · user_id uuid FK.
**RLS on**.

**annotations**: id · document_id →documents **CASCADE** · `user_id` **text** default 'local' (never
converted to uuid) · block_id · highlighted_text · messages jsonb · `summary` · `embedding`
vector(1536). **RLS commented out, never enabled.**

**attachments**: id · document_id **CASCADE** · user_id **text** · file_name · mime_type ·
file_size · drive_file_id NOT NULL · drive_web_view_link. **No RLS, no updated_at.**

**user_google_tokens**: user_id **text** PK · refresh_token NOT NULL · updated_at. **No RLS.**

**document_chunks**: id · document_id **CASCADE** · chunk_index · content · content_hash · heading ·
block_ids text[] · token_count · summary · tags text[] · embedding vector(1536). **No user_id, no RLS.**

**usage_logs**: id · user_id **text** · flow/provider/model · input/output_tokens · document_id
**SET NULL** · created_at. **No RLS.**

**pdf_annotations**: id · drive_file_id (no FK) · user_id **text** · color/type (comment-only enums) ·
page_number · anchor_exact/prefix/suffix · note · messages jsonb. **No RLS.**

**moodboard_state**: document_id uuid **PK** **CASCADE** · tldraw_snapshot jsonb · canvas_settings ·
updated_at. No RLS, no user_id. **moodboard_objects / moodboard_assets**: fully defined, **zero code
references** — dead schema.

**Functions**: `update_updated_at()`; `search_documents(text)` (4 versions, final = trigram, **SECURITY
DEFINER, no user filter**); `match_chunks`/`match_documents`/`match_annotations`/`get_all_tags` (none
user-scoped).

### 1.2 Store shape & cache lifecycle
Tree/UI (`folders`, `rootDocuments`, `openTabs`, `activeDocument*`), chat/annotations, nav history,
raw mirrors `_dbFolders`/`_dbDocuments` (content stripped to `"[]"`), in-memory `_documentCache` /
`_annotationsCache`, dashboard slots. localStorage keys `cortex:cache:*` (7-day TTL). `initialize()`
is two-phase: synchronous cache paint → Supabase revalidate → prune tabs whose docs vanished. A
store-wide `subscribe` persists on a single 300ms debounce.

### 1.3 `ensure*` lazy-creation helpers

| Helper | Lookup | DB uniqueness guard | Called from |
|---|---|---|---|
| `ensureTodoDocument` | `doc_type='todo'` | partial UNIQUE ✓ | initDashboard |
| `ensureDailyParentDocument` | `doc_type='daily_parent'` | partial UNIQUE ✓ | ensureTodayDailyDocument |
| `ensureTodayDailyDocument` | `doc_type='daily'` AND tag=date | **none** | initDashboard |
| `ensureQuickNoteParentDocument` | `doc_type='quick_note_parent'` | **none** | initDashboard, fetchTodayQuickNotes, ensureTodayQuickNoteContainer |
| `ensureTodayQuickNoteContainer` | `parent_document_id=parent` AND tag=date | **none** | createQuickNote |

---

## 2. Schema/type drift (`types.ts` vs final SQL)

| Interface | Drift |
|---|---|
| **DbDocument** | **Missing 6 SQL columns**: `fts`, `ai_summary`, `ai_tags`, `embedding`, `content_hash`, `index_status`. Because `fetchDocument`/`ensure*` use `select("*")`, rows carry all six at runtime — including a ~1536-float embedding and the tsvector — invisible to types, shipped to the browser. `doc_type` union vs unconstrained text. |
| **DbBacklink** | **Missing `user_id`** (added by auth_migration). Written as an untyped literal at db.ts:1059-1065. |
| **DbAnnotation** | **Missing `summary` and `embedding`**. `select("*")` delivers them untyped. |
| **DbFolder** | `created_at`/`updated_at` required in TS but nullable in SQL. |
| **No TS type** | `user_google_tokens`, `moodboard_state` (inline anon type), `moodboard_objects`/`_assets` (unused). |
| **SearchResult vs RPC** | Matches the *trigram* function. But **schema.sql's own `search_documents` still returns `content` and no `snippet`** — a fresh install running only schema.sql yields `snippet:""` and full-doc egress per hit. |

---

## 3. Findings

### CRITICAL

**DATA-C1 — `search_documents` is SECURITY DEFINER with no user filter — cross-user leak from the
browser.** See [Security C3](01-security.md). Called client-side with the anon key at
[db.ts:650](../../src/lib/db.ts#L650); returns titles/tags/snippets for **every** user's documents.

**DATA-C2 — RLS missing on 8 client-reachable tables; Google refresh tokens exposed.** See
[Security C1/C2](01-security.md). `user_google_tokens` is upserted directly from the browser
([auth.tsx:60](../../src/lib/auth.tsx#L60)); annotations/attachments/pdf_annotations/moodboard_state
are read/written from the anon client in `db.ts`.

**DATA-C3 — Stale-cache editor init → silent last-write-wins overwrite (multi-tab / multi-device).**
`setActiveTab` serves the in-memory cached doc instantly and revalidates in the background
([store.ts:468-492](../../src/lib/store.ts#L468-L492)), but the editor is keyed only by id and
`useCreateBlockNote` captures `initialContent` once at mount
([DocumentEditor.tsx:417-431](../../src/components/DocumentEditor.tsx#L417-L431)); when the background
fetch replaces `activeDocument`, BlockNote is **never re-seeded**. Tab/device B edits doc X; tab A
(holding stale X) reopens it, user types one char, the 1s autosave writes the **entire stale block
array** back → B's edits destroyed. No version/`updated_at` check exists in `updateDocument`
([db.ts:306-338](../../src/lib/db.ts#L306-L338)). Pairs with [UI-H2](04-ui-editor.md).

**DATA-C4 — Debounced save dropped on unmount and tab close — guaranteed data-loss window.** See
[UI-C1/C2](04-ui-editor.md). Cleanup clears the pending timer without flushing
([DocumentEditor.tsx:700-710](../../src/components/DocumentEditor.tsx#L700-L710)); no
`beforeunload`/`pagehide`/`visibilitychange` anywhere. Title/subtitle/tags save on blur only, so
closing with focus in the title field loses the rename too.

### HIGH

**DATA-H1 — `ensure*` check-then-create races (double-creation / hard failure).** All five helpers
are non-atomic find-then-insert with no upsert/conflict handling. Quick-note parent, container, and
daily doc have **no unique index**, so two tabs mounting the Dashboard concurrently
(`Dashboard.tsx:21` runs `initDashboard()` on every mount) both pass `maybeSingle()` and both insert
→ duplicate parents/containers/dailies; subsequent `limit(1).maybeSingle()` **with no ORDER BY**
picks nondeterministically → quick notes scatter across two parents. For `todo`/`daily_parent` the
partial unique index makes the loser's insert **throw** uncaught → `todoDocId` stays null, widgets
dead until reload. In-process races are real too (`initDashboard` runs helpers in `Promise.all`;
`fetchTodayQuickNotes` re-runs the parent helper ms later). Compounding **date-boundary bug**: the
daily tag uses **UTC** (`toISOString().slice(0,10)`) while the title uses **local** date — evening
users west of UTC get a "today" doc tagged tomorrow → duplicate dailies around midnight.

**DATA-H2 — Full-table fetches with no pagination — silent truncation at PostgREST's 1000-row cap,
which then deletes user state.** `fetchDocuments()`/`fetchFolders()` select the whole table unbounded.
Past 1000 documents docs vanish from the sidebar, and worse, `initialize()`'s tab validation
([store.ts:357-374](../../src/lib/store.ts#L357-L374)) treats any open tab whose doc isn't in the
truncated fetch as deleted and **closes it**, persisting the cache without it. Also unbounded:
`fetchTodayQuickNotes` children, `propagate*`, `deleteFolder`'s collection.

**DATA-H3 — Fire-and-forget optimistic deletes with no rollback.** `deleteDocument`/`deleteFolder`
remove rows locally, rebuild, **persist the cache**, then run the DB delete with only
`.catch(console.error)`. If the delete fails (offline/RLS/FK), UI and localStorage both claim the row
is gone; Phase-2 revalidation resurrects it — a "deleted note comes back" bug. Same pattern in
`renameFolder`, `moveDocument`, `moveFolder`, `setParentDocument`.

**DATA-H4 — Dashboard read-modify-write clobbers the todo/system docs (document-granularity LWW).**
`addTodo`/`toggleTodo` fetch the todo doc, mutate the parsed block array, write the **whole content**
back. Two rapid toggles (or the dashboard + the todo doc open in the editor — it's a normal doc)
interleave fetch/fetch/write/write → first write lost. `syncDailyParentDatabase`/
`syncQuickNoteDatabases` rewrite entire parent-doc contents on **every dashboard mount**.

**DATA-H5 — `syncQuickNoteDatabases` is O(days) N+1 that grows forever.**
[db.ts:1753-1800](../../src/lib/db.ts#L1753-L1800): per day-container queries + full-content writes.
After a year (~365 containers) → ~730+ round-trips and up to 366 full writes on **every dashboard
mount and every quick note added**.

### MEDIUM

**DATA-M1 — Title-save propagation rewrites other documents wholesale.** `saveDocument` with a title
triggers `propagatePageLinkTitle` + `propagateDatabaseRowTitle`, each doing `.like("content","%<id>%")`
over all documents then serial full-content `updateDocument` per match — another LWW hazard against
docs edited elsewhere, on **every title blur**.

**DATA-M2 — `syncBacklinks` is delete-then-insert, non-atomic, on every autosave.** A failure/tab
close between delete and insert leaves the doc with zero outgoing backlinks until the next save.

**DATA-M3 — `select("*")` on documents ships embeddings/tsvectors to the browser.** ~20-35 KB of JSON
vector + the `fts` tsvector per row, on every doc open and in every `ensure*`. `DOCUMENT_META_COLUMNS`
already exists as the fix.

**DATA-M4 — `JSON.parse` of jsonb `messages` without try/catch.** db.ts:724, 769, 1324 (inside a
`.map`, so one bad row kills the whole list), 1380. Contrast the correct guarded parsers elsewhere
(`extractTextFromContent`, `safeParseBlocks`).

**DATA-M5 — Cache-persist subscriber can drop writes.** The single shared 300ms timer evaluates only
the **last** `(state, prev)` pair; a `_dbDocuments` change followed within 300ms by an unrelated
change is skipped. Partly masked by `_rebuildTree`'s direct persist, but `createFolder`/
`createDocument` mutate the raw arrays without `_rebuildTree` and rely on this lossy subscriber.

**DATA-M6 — localStorage quota/corruption handling is asymmetric.** Store `cacheWrite` swallows quota
errors silently; three separate `setItem`s in `persistSidebarCache` can partially fail → mismatched
folders/documents restored on next boot. Local-mode `setLocalFolders`/`setLocalDocuments` have **no
try/catch** — QuotaExceededError propagates mid-mutation.

**DATA-M7 — `position` is dead — sidebar order is nondeterministic.** Nothing writes `position`
except the constant 0, yet fetches `order by position` → ties returned in unspecified order → sidebar
can shuffle between reloads.

**DATA-M8 — Delete-cascade gaps leave remnants.** documents→chunks/backlinks/annotations/attachments/
moodboard cascade correctly. But: folders nested **under** a deleted document survive via
`parent_document_id SET NULL` and pop to root; `deleteAttachment` orphans `pdf_annotations` forever
(no FK); deleting an auth user leaves annotations/attachments/pdf_annotations/usage_logs/
user_google_tokens (text user_id, no FK). Also the source of the [UI-C4](04-ui-editor.md) dialog lie.

**DATA-M9 — Architecture rule bypassed for writes (staleness).** No component calls `supabase`
directly, but 9 components import `db.ts`; **DatabaseTable.tsx** and **DocumentEditor.tsx** perform
*writes* (`dbCreateDocument`/`dbUpdateDocument`) that never update `_dbDocuments`/`_documentCache`, so
new database-row notes don't appear in the sidebar until a full `initialize()`. `NoteSettingsButton`
updates `share_slug` without touching `activeDocument.shareSlug`.

**DATA-M10 — Every 1s autosave hits three GIN indexes + a generated tsvector.** `fts` is STORED over
full content and content carries two trigram GIN indexes → each debounced save recomputes the tsvector
+ maintains three GINs. Disproportionately expensive server-side for large notes. (See [AI-M10](03-ai-subsystem.md)
— these indexes are built over raw BlockNote JSON.)

### LOW

`DATA-L1` slug-collision retry missing in `toggleShareLink`. `DATA-L2` `getCurrentUserId()` returns
`"local"` when signed out → uuid cast error. `DATA-L3` unused var in `createFolder` reconcile.
`DATA-L4` `created_at`/`updated_at` nullable in SQL but required in types → `.localeCompare` crash on a
manual NULL insert. `DATA-L5` `doc_type` no CHECK. `DATA-L6` permanent FK-hint-join fallback masks
schema misconfig. `DATA-L7` `moodboard_objects`/`_assets` dead schema. `DATA-L8` schema.sql's
`search_documents` diverges from all later versions. `DATA-L9` `stripDocContent` caches `settings`
but `fetchDocuments` fabricates `settings:{}` — cached row lies about both.

---

## 4. Migration hygiene

**Implied order (nothing encodes it — no numbering, no migration table):** schema → phase2 →
annotations → settings → subnotes → auth → attachments → ai → pdf_annotations → dashboard → share →
folder_parent_doc → moodboard → search_snippet → search_documents_auth_fix (*superseded*) →
trigram_search.

- **schema.sql is a rolling snapshot, not a baseline** — it has absorbed some later work (making
  `phase2`/`settings`/`subnotes`/`attachments` no-ops on fresh installs) but **not** doc_type,
  share_slug, the AI columns, or the snippet search fn. **There is no single file that produces the
  current schema.** A fresh `schema.sql`-only install errors on `folders.parent_document_id` and has
  no search snippet.
- **Idempotency:** tables/indexes/extensions use `IF NOT EXISTS` ✓; search-fn migrations `drop`+`create`
  ✓. But **all 7 `CREATE TRIGGER`** and **all `CREATE POLICY`** statements are **non-idempotent**
  (re-run → 42710/duplicate). **auth_migration.sql is destructive and single-shot** — it hard-DELETEs
  all `user_id='local'` rows and its `ALTER COLUMN ... TYPE uuid` sequence fails on re-run and fails
  outright if any non-uuid user_id remains.
- **Out-of-order breakage:** AI/annotations/pdf/moodboard before schema → missing `update_updated_at()`
  aborts; `share` before `auth` is inert-until-auth; the relative order of trigram/snippet/auth_fix
  **silently determines which `search_documents` semantics win** (user-filtered vs leaking) and the
  client can't tell. **IVFFlat indexes are left as comments** with a manual "run later" note — nothing
  ensures they're ever created, so `match_*` degrade to sequential scans.

**Recommended:** adopt `supabase/migrations/` timestamped files with CLI schema_migrations tracking;
make triggers/policies idempotent; regenerate a true baseline; add CHECK constraints for
doc_type/color/type; add partial unique indexes for `quick_note_parent` and per-day dailies; treat
DATA-C1/C2 as ship-blockers for any multi-user deployment.
