# Codex MCP + Candidate Edits — Spec

Status: **proposal, awaiting answers to §12**. Written 2026-08-21 after reading the current tool loop
([src/lib/ai/tools.ts](../src/lib/ai/tools.ts), [chat/route.ts](../src/app/api/ai/chat/route.ts),
[router.ts](../src/lib/ai/router.ts)), the editor save path, the store, and the auth layer.

---

## 0. In one paragraph

Expose Codex to external Claude clients (claude.ai, Claude Desktop, Claude Code) through a **remote MCP
server hosted inside the Next.js app** at `/api/mcp`. It shares one tool registry with the in-app chat
loop. Reads are direct. **Writes are never direct**: Claude can only create *proposals* — a first-class
`note_proposals` row that the paired browser renders as green (added) / blue (removed) marks over a
read-only preview, with an Accept / Reject bar. Only a human click applies the change, through the same
`expectedUpdatedAt`-guarded save the editor already uses. A server-side **intent gate** refuses
proposal calls whose quoted user instruction reads as a question rather than an explicit edit request.
One browser per user is the "surface" Claude drives; it's chosen through a pairing-code handshake in
Settings → Connect to Claude.

---

## 1. Goals and non-goals

**Goals**

- Claude (outside the app) can find, read, and reason over notes with the same isolation guarantees as
  the in-app chat (`runAsUser`, scoped service-role queries).
- Claude can drive the UI of exactly one paired browser: know what's open / selected, open a note.
- Claude can propose edits and new notes. Proposals are visible, diffed, reviewable, and inert until
  accepted.
- Proposing is hard to trigger by accident. Questions and feedback about text do not become edits.
- The in-app chat panel gets the same capability (proposals instead of silent `create_note`).

**Non-goals (for this spec)**

- Raw SQL from Claude. Typed tools only; see §11 for an optional, locked-down read-only variant later.
- Deleting notes, moving folders, or bulk operations from Claude.
- Live collaborative editing / CRDT. We keep whole-column saves with stale-write detection.
- Editing moodboards, database blocks, or PDFs. Proposals cover prose notes (`note`, `daily`,
  quick notes).

---

## 2. What exists, and what to keep / change

The current loop works and the isolation layer is good. But as the base for an MCP surface it has
specific problems worth fixing rather than duplicating.

**Keep**

- `getToolDb()` — service-role client that forces `user_id` on every select and `p_user_id` on every
  RPC. This is the actual tenant boundary; the MCP route uses it unchanged.
- `runAsUser()` / `uid()` (AsyncLocalStorage, fails closed). Wrap every MCP tool call in it.
- `createFolderPathResolver`, folder-path resolution in `create_note`, `markdownToBlockNote`,
  `blocksToPlainText`.
- `serverAuth.getUserFromRequest` — validates a Supabase JWT. The MCP route reuses it for OAuth and
  bearer tokens alike.
- Editor's `expectedUpdatedAt` → `StaleWriteError` → `applyRemoteDocument` reseed path. Accepting a
  proposal is "a save from elsewhere", and the editor already knows how to absorb one.

**Change**

| Today | Problem | Proposed |
|---|---|---|
| 27 read tools + `create_note`, 2,285 lines, one `switch` | Heavy overlap (`get_recent_documents` ≈ `get_recently_modified`; five different search entry points; three ways to get doc metadata). ~3–4k tokens of schema on every model round. Hand-written JSON schema, Anthropic-only. | A **registry**: `defineTool({ name, description, input: z.object(...), annotations, execute })`. Emits Anthropic `tools[]` for the chat loop and registers on the MCP server. Consolidate to **6 read tools** (§6). |
| `truncateToolResult` cuts at the last comma and appends `],"_truncated":true}` | Produces invalid JSON for any non-array top-level shape. | Truncate *inside* known list fields (`results`, `content`) and set `truncated: true` on the object. |
| `search_notes` = per-keyword title `ilike` OR'd + `search_documents` RPC, title hits first, no score | Can't tell Claude how confident a match is; "find my note about X" needs disambiguation. | `find_notes` ranks by `similarity(title, q)` (pg_trgm, already installed) + FTS rank + optional vector, returns `confidence`. |
| `create_note` writes directly | Contradicts the new rule: Claude never writes. | Becomes `propose_new_note`. |
| Chat SSE special-cases `doc_created` by tool name | Each new side-effecting tool needs another branch. | Generic `tool_event { tool, payload }`; `ChatPanel` dispatches on payload kind. |
| Router (regex + Groq) picks a *retrieval tier* | It's not an intent classifier, and shouldn't become one. | Separate **edit-intent gate** (§8) that both surfaces call. |

---

## 3. Architecture

```
 Claude client (claude.ai · Desktop · Claude Code)
        │  MCP Streamable HTTP  ·  Authorization: Bearer <Supabase JWT | PAT>
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ Next.js app (Vercel)                                            │
 │  /api/mcp/[transport]      mcp-handler · auth · runAsUser        │
 │  /.well-known/oauth-protected-resource → Supabase auth server    │
 │  /api/proposals/:id/accept|reject  (human-only, bearer)         │
 │  /api/ai/chat              existing loop, same tool registry     │
 │                                                                  │
 │  src/lib/ai/tools/*        registry (zod)  ──┐                   │
 │  src/lib/proposals/*       ops · diff · preview · apply          │
 └───────────────┬──────────────────────────────┼───────────────────┘
                 │ service role, user-scoped    │ broadcast (REST)
                 ▼                              ▼
 ┌──────────────────────────┐     ┌─────────────────────────────┐
 │ Supabase Postgres        │     │ Supabase Realtime            │
 │ documents, note_proposals│     │ private channel              │
 │ claude_links, mcp_tokens │     │ surface:{userId}             │
 └──────────────▲───────────┘     └──────────────┬──────────────┘
                │ anon key + RLS (state mirror, acks)             │ commands
                └────────────────── paired browser ◄─────────────┘
                                   useSurfaceLink() · ProposalReview · Settings
```

Pieces:

- **Tool registry** `src/lib/ai/tools/` — one definition per tool, zod input, `execute(input, ctx)`.
  `ctx` carries `userId`, `surface` (link row or null), `source: 'mcp' | 'chat'`.
- **MCP route** `src/app/api/mcp/[transport]/route.ts` — `mcp-handler` (Vercel's Streamable-HTTP
  adapter; stateless, no Redis). `maxDuration = 60` so `await_review` / `connect_to_codex` can long-poll.
- **Surface link** — `claude_links` row (one per user) + Realtime private broadcast channel.
- **Proposals** — table, server module, two human-only endpoints, client review UI.
- **Client** — `useSurfaceLink()` hook (heartbeat, state mirror, command listener), `ProposalBar` +
  preview editor, Settings "Connect to Claude" panel, badges in sidebar/tabs.

---

## 4. Auth and pairing ("Connect to Claude")

Two layers, deliberately separate: **identity** (which account) and **surface** (which browser window).

### 4.1 Identity

**A — Supabase OAuth 2.1 Server (recommended; needed for claude.ai / Desktop).** Supabase Auth can act
as the OAuth 2.1 authorization server for MCP clients — GA, with dynamic client registration and PKCE.
Codex already uses Supabase Auth, so:

1. Enable the OAuth server in the Supabase dashboard.
2. Serve RFC 9728 metadata at `/.well-known/oauth-protected-resource` pointing at the project's
   authorization server. Clients discover it from a `401` + `WWW-Authenticate` on `/api/mcp`.
3. The client runs DCR + PKCE against Supabase; the user logs in with Google as today.
4. The access token is a normal Supabase JWT → `getUserFromRequest()` validates it unchanged.

Consent UI can be hosted in our app (Supabase supports a custom authorize page) — that's where the
pairing code (§4.2) can also be shown. Verify the exact issuer path and custom-page mechanics against
the Supabase docs at implementation time.

**B — Personal access token (day one; Claude Code and scripts).** Settings → Connect to Claude →
"Create token" → `cdx_…` shown once, stored as a SHA-256 hash in `mcp_tokens`. Used as
`Authorization: Bearer cdx_…`:

```bash
claude mcp add --transport http codex https://<app>/api/mcp --header "Authorization: Bearer cdx_…"
```

claude.ai's connector UI has no header field, so B alone doesn't reach claude.ai/Desktop.

### 4.2 Surface pairing — "make sure the codes match"

OAuth proves the account. Pairing picks the **one** browser window Claude may drive and adds the
visible human step you described.

1. Claude calls `connect_to_codex()` (or any workspace tool while unpaired). Server creates
   `pairing_requests { code: "7K3-QPD", client_label, expires_at: +5 min }` and returns the code.
   Claude tells the user: *"Pairing code **7K3-QPD** — confirm it in Codex → Settings → Connect to
   Claude."* The tool long-polls up to 55 s for the outcome.
2. The browser's Settings panel (subscribed to the surface channel while open) shows:
   **Claude (claude.ai) wants to connect · 7K3-QPD · [The codes match — connect] [Deny]**
3. Confirm → upsert `claude_links { user_id PK, surface_id, surface_label }`. The PK enforces
   one browser per user. Any other tab with a different `surface_id` receives `link_changed` and
   shows "Another window is connected to Claude · [Take over]".
4. `connect_to_codex` resolves `paired`. Workspace tools now work.

- `surface_id` lives in `localStorage`; pairing survives reloads. Re-pair only when switching browsers.
- Heartbeat every 15 s; `last_seen_at` older than 45 s ⇒ offline. Workspace tools then return
  `{ ok:false, code:'surface_offline', message:'Codex isn't open in the paired window. Ask the user to open Codex, or to re-pair from Settings.' }`.
- Settings shows: paired window label, last seen, **Disconnect**, token list with revoke.

### 4.3 Tables

```sql
create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table pairing_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  client_label text,
  status text not null default 'pending' check (status in ('pending','confirmed','denied','expired')),
  surface_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table claude_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  surface_id text not null,
  surface_label text,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  state jsonb not null default '{}'::jsonb
);
-- RLS: owner select/update on all three (browser writes claude_links.state and answers pairing_requests).
```

---

## 5. The surface channel (browser ↔ server)

There is no realtime channel in the app today. The MCP route runs in a stateless function, so the
channel must not require the server to hold a socket.

- **Server → browser:** Supabase Realtime **private** broadcast channel `surface:{userId}`
  (`config: { private: true }` + an RLS policy on `realtime.messages` so only `auth.uid() = userId`
  can join). The server publishes over REST with the service role — no persistent connection.
  Messages: `open_note {documentId, blockId?}`, `flush_save`, `proposal_created {proposalId,
  documentId}`, `proposal_withdrawn`, `document_updated {documentId, updatedAt}`, `pairing_request
  {code, clientLabel}`, `link_changed {surfaceId}`.
- **Browser → server:** no broadcast. The browser writes `claude_links.state` (anon key, RLS) on
  change, debounced 300 ms, plus heartbeat. Server "awaits an ack" by polling that row
  (250 ms, ≤ 3 s). Keeps the server stateless and the protocol trivially debuggable.
- **State mirror shape:**

  ```ts
  { activeDocumentId: string|null, activeTitle: string|null,
    view: 'dashboard'|'document'|'graph',
    openTabs: {id:string,title:string}[],
    selection: { docId:string, text:string, blockIds:string[] } | null,
    isDirty: boolean,            // editor has an unsaved 1s-debounce pending
    pendingProposalIds: string[] }
  ```
- **"In my current note"** → `read_note({ current: true })` → `state.activeDocumentId`; if
  `isDirty`, send `flush_save`, wait for `isDirty=false` (≤ 2 s), then read from Postgres. Selection
  text comes straight from the mirror.
- **Fallback** if Realtime is undesirable: an `mcp_commands` table the paired browser polls every
  2 s. Same message shapes; swap the transport, not the protocol.

---

## 6. Tool catalog (MCP)

Sixteen tools. Descriptions are short; the policy text lives once in the server `instructions` and is
repeated only on the two `propose_*` tools.

### Read (`readOnlyHint: true`) — replaces 22 of today's 27

| Tool | Input | Returns / notes |
|---|---|---|
| `find_notes` | `query`, `limit=8`, `mode: auto\|title\|content\|semantic`, `filters?: { folder, tags[], from, to, similarTo }` | Ranked `{ id, title, folderPath, updatedAt, summary, matchedOn, confidence: high\|medium\|low }`. Title trigram + FTS (`search_documents`) + vector (`match_documents`). "If the user named a specific note and top confidence isn't `high`, ask which one." Absorbs `search_notes`, `search_document_content`, `search_by_tags`, `search_by_date`, `find_similar_documents`, `get_daily_note`. |
| `read_note` | `ref: { documentId } \| { current: true } \| { title }`, `format: anchored\|plain\|outline`, `range?` | Meta + body. `anchored` (default) is markdown with a block anchor per line (§7.3). `outline` returns chunk summaries. Also `isOpenInCodex`, `hasUnsavedEdits`, `pendingProposalId`. |
| `get_note_info` | `documentIds[]` (1–20), `include?: ['links','hierarchy','annotations','lengths']` | Metadata, word counts, parent chain, in/out links. Absorbs `get_document_info`, `batch_get_document_info`, `compare_documents`, `get_document_lengths`, `get_document_hierarchy`, `get_backlinks`, `get_document_children`, `get_annotations`. |
| `browse` | `folder?: id \| name \| "A > B"`, `depth=1`, `includeDocs=true` | Folder tree slice with counts. Absorbs `get_folder_tree`, `list_folder_contents`, `get_folder_info`. |
| `get_activity` | `kind: recent\|stats\|orphans\|count`, `sortBy`, `groupBy`, `from`, `to`, `folder`, `tag`, `limit` | Absorbs `get_recent_documents`, `get_recently_modified`, `get_writing_stats`, `count_documents`, `get_orphan_documents`. |
| `get_tags` | `minCount=1`, `cooccurrence=false` | Absorbs `get_all_tags`, `get_tag_graph`. |

### Workspace (needs a live paired surface)

| Tool | Input | Notes |
|---|---|---|
| `get_workspace_state` | — | The state mirror + link label + pending proposals. |
| `open_note` | `documentId`, `blockId?` | Broadcasts `open_note`, waits for ack (≤ 3 s). |
| `add_to_chat_context` | `documentIds[]` | Pins notes in the in-app chat. Optional; cheap. |

### Write — review-gated (`destructiveHint: false`)

| Tool | Input | Notes |
|---|---|---|
| `propose_edit` | `target: { documentId } \| { current: true }`, `summary` (≤ 120 chars), `instruction_quote`, `confirmation_quote?`, `ops[]` (1–50) | Runs the gate (§8), validates ops, builds preview, stores, notifies. Returns `{ proposalId, hunks, status:'pending' }` plus a hint: *tell the user to review in Codex; do not say the note was changed.* |
| `propose_new_note` | `title`, `markdown`, `folder?`, `tags?`, `summary`, `instruction_quote`, `confirmation_quote?` | Same gate. Appears as a ghost note until accepted. |
| `get_proposal` | `proposalId` | Status. If `stale`, includes fresh anchors for the touched blocks. |
| `await_review` | `proposalId`, `timeoutSec ≤ 55` | Long-polls; resolves `accepted \| rejected \| pending`. |
| `withdraw_proposal` | `proposalId` | Claude can retract its own pending proposal. |

### Pairing

| Tool | Notes |
|---|---|
| `connect_to_codex` | Returns the code, long-polls ≤ 55 s, resolves `paired \| pending \| denied`. |
| `connection_status` | Paired? Online? Which window? |

**Deliberately not exposed:** `accept_proposal` / `reject_proposal` (human-only, browser-only),
delete, move/rename (P2 as metadata proposals), raw SQL, backfill/index.

---

## 7. Candidate edits (proposals)

### 7.1 Principles

1. **Nothing Claude does mutates a note.** A proposal is inert data. Only `POST
   /api/proposals/:id/accept` from the paired browser writes to `documents`.
2. **The preview never touches autosave.** Review renders into a second, read-only editor; the live
   editor is unmounted while reviewing so the 1 s debounce cannot fire on preview content.
3. **Ops are anchored, not positional.** Every op targets a block id and carries the hash of that
   block as Claude saw it, so a proposal can still apply (or fail honestly) after the user keeps typing.
4. **Claude can't quietly replace a whole note.** `rewrite_all` exists but is refused for notes that
   contain blocks markdown can't round-trip.

### 7.2 Data model

```sql
create table note_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,   -- null for kind='create'
  kind text not null check (kind in ('edit','create')),
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','stale','superseded','withdrawn','expired')),
  source text not null check (source in ('mcp','chat')),
  client_label text,                  -- "claude.ai", "Claude Code", "Codex chat"
  summary text not null,              -- one line, shown in the bar
  instruction_quote text not null,
  gate_verdict text not null,         -- explicit | confirmed  (audit trail)
  -- create
  title text, folder_id uuid references folders(id), tags text[],
  -- edit
  ops jsonb not null default '[]'::jsonb,        -- [{ id, type, anchor, blockId, baseHash, ... }]
  base_updated_at timestamptz,
  base_content_hash text,
  base_content jsonb,                  -- snapshot for "Undo" after accept
  result_blocks jsonb,                 -- full doc if every op is accepted
  preview_blocks jsonb,                -- merged view with suggestion marks
  hunks jsonb not null default '[]'::jsonb,      -- [{ id, opId, kind, anchor, before, after }]
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  applied_updated_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index on note_proposals (user_id, status);
create index on note_proposals (document_id) where status = 'pending';
-- RLS: owner select. Status changes go through the API (service role), never from the browser directly.
```

### 7.3 Op language and anchors

`read_note` (format `anchored`) gives Claude stable handles. Anchors are the shortest unique prefix of
the BlockNote block id (6 chars by default):

```
⟦a1f2c9⟧ # Reading: Weil, Gravity and Grace
⟦b7e210⟧ First pass through the notebooks. Three themes keep recurring…
⟦c03d44⟧ ## Attention
⟦d9a8f1⟧ - Attention as the rarest form of generosity
⟦e4b6c2⟧   - (child) cf. ⟦pageLink: Simone Weil — biography⟧
⟦f51e07⟧ [database block "Quotes" · 3 columns × 12 rows — not editable with markdown]
```

Ops (server assigns `id`, resolves `anchor → blockId`, records `baseHash`):

| Op | Fields | Semantics |
|---|---|---|
| `replace_text` | `anchor`, `find`, `replace` | Inline. `find` must occur exactly once in the block's plain text. Untouched runs keep their styles. Preferred for small edits. |
| `replace_block` | `anchor`, `markdown` | Whole block. Children preserved. |
| `insert_after` | `anchor \| "start"`, `markdown` | One or more blocks. |
| `delete_block` | `anchor` | Block and children. |
| `append` | `markdown` | At the end of the note. |
| `rewrite_all` | `markdown` | Whole note. **Refused** if the note contains `database`, `image`/`file`, `column`, or `pageLink`-bearing blocks — the error lists their anchors and tells Claude to use targeted ops. |

Markdown → blocks via the existing `markdownToBlockNote` (extend it to turn `[[Title]]` into a
`pageLink` when a title matches). Blocks → anchored markdown via the currently-unused
`blocksToMarkdown.ts`, resurrected, with non-convertible blocks rendered as bracketed descriptions.

### 7.4 Server pipeline (`propose_edit`)

1. Resolve target (`current` → surface state; flush if dirty). Must be owned, `doc_type ∈ {note,
   daily, quick note}`, no `database`-only docs.
2. **Gate** (§8). Refuse with a structured, actionable error if it fails.
3. Resolve anchors against the current content; reject unknown/ambiguous anchors, `find` strings that
   match ≠ 1 time, ops over `database`/`column` blocks.
4. Compute `result_blocks` (apply all ops) and `preview_blocks` (§7.5) and `hunks[]`.
5. Supersede any pending proposal on the same note (status `superseded`); refuse if one was created
   < 30 s ago by the same source (spam brake).
6. Insert row, broadcast `proposal_created`, return.

### 7.5 Review UI

**Where it shows.** When the open note has a pending proposal, `DocumentEditor` swaps to review mode:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● Claude proposes 3 changes · "Tighten the intro and add a Summary section"  │
│   from claude.ai · 2 min ago         [Show original]   [Reject]  [Accept all] │
└──────────────────────────────────────────────────────────────────────────────┘
  # Reading: Weil, Gravity and Grace
  First pass through the notebooks. ~~Three themes keep recurring and I~~
  ~~want to get them down before I forget.~~ Three themes recur: attention,
  decreation, and affliction.
                                                        ^^^^ green = added
  ## Attention                                          ~~~~ blue  = removed
  …
  ## Summary                      ← whole block added: green left rule + tint
  Weil's notebooks circle one move: …
```

- **Marks.** Inline word-level diff (`diffWords`) inside changed text blocks: inserted runs carry a
  custom BlockNote style `suggestion: "insert"` (green tint, e.g. `#dcfce7` / text `#166534`),
  removed runs `suggestion: "delete"` (blue tint `#dbeafe`, text `#1e40af`, strikethrough).
  Whole-block add/remove (and non-text blocks) get a block-level decoration: 3 px left rule + faint
  tint in the same hue. Implemented with `createReactStyleSpec` for inline and a small ProseMirror
  decoration plugin keyed by block id for block-level.
- **Preview editor.** A second `useCreateBlockNote` instance, `editable={false}`, same schema +
  the `suggestion` style, seeded with `preview_blocks`. The live editor is unmounted.
- **Bar actions.** *Accept all* → §7.6. *Reject* → status `rejected`, back to the live editor.
  *Show original* toggles marks off. *Dismiss for now* (overflow menu) hides the preview but keeps
  the proposal pending and the badge lit. ⌘⏎ accepts; there is no keyboard reject.
- **Per-hunk** (P2): a stepper in the bar (`1/3 ‹ ›`, ✓ / ✗ per hunk). Accepting a subset
  recomputes the result from accepted ops only.
- **Not the open note.** Toast "Claude proposed changes to *Weil notes* · [Review]"; a green dot on
  the sidebar item and tab. A small **Proposals** inbox (count badge) in the chat panel header lists
  all pending ones.
- **New notes** (`kind='create'`). A ghost entry (dashed outline, "Proposed") in the target folder;
  opening it shows the full body as an insertion with the same bar. Accept creates the document via
  the normal insert path; Reject removes the ghost.

### 7.6 Accept pipeline

`POST /api/proposals/:id/accept { hunkIds? }` — bearer-authed, service role, `runAsUser`:

1. Load proposal + current document. If `status ≠ pending` → 409.
2. If `documents.updated_at == base_updated_at` → use `result_blocks` (or recompute from the
   accepted subset).
3. Else **rebase**: for each accepted op, locate the block by id in the current content; if its hash
   equals `baseHash`, apply; if missing or changed → conflict. Any conflict → 409 `{ stale: true,
   conflicts: [hunkIds] }`; the bar shows "The note changed since this was proposed — 1 of 3 changes
   can't apply · [Apply the rest] [Reject]". Proposal status → `stale` until resolved.
4. `updateDocument(id, { content }, { expectedUpdatedAt })` (server-side, same function the editor
   uses). On `StaleWriteError`, retry the rebase once, then 409.
5. Server-side `syncBacklinks` (today it's client-only; add the server helper), then fire-and-forget
   `indexDocument`.
6. Mark `accepted`, set `applied_updated_at`, broadcast `document_updated`.
7. Browser: store updates `activeDocument`; the existing `applyRemoteDocument` reseeds the live
   editor; review mode closes; toast "Applied 3 changes · Undo" (30 s; Undo writes `base_content`
   back with the same guard).

Reject: `status='rejected'`, `resolved_at`, broadcast. No document write.

### 7.7 What Claude sees

- `propose_*` returns immediately with `proposalId`. The description instructs: *say you've proposed
  the change and where to review it; never say the note was updated.*
- `await_review` lets Claude block (≤ 55 s) when the user is clearly at the keyboard.
- On `rejected`, Claude can ask what to change. On `stale`, `get_proposal` returns fresh anchors for
  the touched blocks so a re-propose is one cheap call, not a re-read.

---

## 8. The intent gate

We don't control the client model's reasoning, so the guard has to live server-side and be
independent of prompt obedience. Defense in depth:

1. **Policy text, once.** MCP server `instructions` + both `propose_*` descriptions: *Only propose
   when the user explicitly asked for the note to be changed. Questions, critiques, "what would you
   change", "is this too long" → answer in chat. If unsure, ask "Want me to propose that as an edit
   to ‹title›?" and only then call with their reply as `confirmation_quote`.*
2. **Required evidence.** `instruction_quote` — the user's words, verbatim — is a required input.
   Optional `confirmation_quote` for the ask-then-confirm path.
3. **Classifier** `classifyEditIntent(instruction, confirmation?)` →
   `explicit | implicit | question | unclear`:
   - Fast path (regex, no API): imperative edit verb (`update, edit, change, rewrite, add, insert,
     append, remove, delete, fix, replace, put, tighten, expand, shorten, reorganize`) aimed at a
     note/section/paragraph/"this"/"it"/"my …" ⇒ `explicit`. Interrogatives (`?`, `what/how/should/
     is this/do you think/would you`) with no imperative ⇒ `question`.
   - Otherwise Groq 8B through `groqLimited()` (or Haiku) with a tight few-shot rubric,
     `temperature 0`, one token out.
   - Passes only on `explicit`, or `implicit` **with** an affirmative `confirmation_quote`.
4. **Refusal is actionable.** `{ ok:false, code:'needs_explicit_request', message:'The quoted message
   reads as a question or feedback, not a request to change the note. Answer it in chat. If they want
   the change, ask "Want me to propose that edit to ‹title›?" and call again with their reply as
   confirmation_quote.' }`
5. **Brakes.** ≤ 1 pending proposal per note (new supersedes), ≤ 50 ops, ≤ 20k chars of markdown,
   30 s spam window. Every verdict logged (`proposal_gate_logs`) for tuning. Settings toggle
   **Strict mode**: always require `confirmation_quote`.

| User said | Verdict | Result |
|---|---|---|
| "Is the intro too long?" | question | answer in chat |
| "The intro is too long." | implicit | blocked → Claude asks; "yes" unlocks |
| "Tighten the intro." | explicit | proposal |
| "Could you tighten the intro?" | explicit (polite imperative) | proposal |
| "What would you change about this?" | question | answer in chat |
| "Add a section on attention to my Weil note." | explicit | proposal |
| "yes, do it" (after "want me to propose…") | confirmation | proposal |

And after all of that, the Accept button is the real safety. The gate is about **noise**, not
**safety** — even a gate miss produces only an inert preview.

---

## 9. In-app chat parity

- The chat loop consumes the same registry. It gains `propose_edit` / `propose_new_note`;
  `create_note` is removed (or kept behind an opt-in "trusted chat" setting — your call, §12).
- `instruction_quote` for the chat surface is verified server-side against the actual last user
  message (the server has it), so the chat path can't be talked into a forged quote.
- SSE gains a generic `tool_event`; `ChatPanel` renders a proposal card ("Proposed 3 changes to
  *Weil notes* · Review") and the editor enters review mode through the same store path.
- The `BASE_SYSTEM` prompt gets the policy paragraph from §8.1. The TIER0 regexes ("fix / improve /
  edit this") stop being retrieval-only hints: with a note open and the gate passed, Claude proposes.

---

## 10. Phasing

**P0 — Foundations (≈ 2–3 days).** Registry refactor (zod, consolidated read tools, chat loop
switched over). `/api/mcp` via `mcp-handler` with PAT auth. Settings → Connect to Claude (token
create/revoke, pairing confirmation). `claude_links` + heartbeat + state mirror + Realtime private
channel. Read + workspace tools. *Exit:* from Claude Code, "what note do I have open?" and "open my
note on Weil" work against the paired window.

**P1 — Candidate edits (≈ 4–5 days).** `note_proposals`, op language, anchored `read_note`,
diff/preview engine, suggestion styles + block decorations, intent gate, `propose_*` tools,
`ProposalBar` + preview editor (accept all / reject), accept pipeline with rebase/stale, toasts and
badges, chat parity. *Exit:* "add a summary section to my current note" → green preview → Accept →
saved, backlinked, indexed. "Is this intro too long?" never produces a proposal.

**P2 — Reach and polish (≈ 3 days).** Supabase OAuth 2.1 server for claude.ai / Desktop. Per-hunk
accept. Ghost notes + Proposals inbox. Metadata proposals (title / tags / folder). Undo after accept.
Expiry job.

**P3 — Optional.** Read-only SQL tool under a dedicated Postgres role (`SELECT` only, user-scoped
views, `statement_timeout`), off by default. Annotation tools. Database-block row ops.

---

## 11. Risks and sharp edges

- **Markdown round-trip fidelity.** `pageLink` inlines, multi-column, database blocks, images. The
  op language sidesteps most of it (untouched blocks are copied byte-for-byte), `rewrite_all` is
  refused for those notes, and `replace_text` splits inline runs rather than re-serializing them.
- **Autosave during review.** Must be structurally impossible, not just guarded: the live editor is
  unmounted, the preview editor has no `onChange`.
- **Staleness.** Users keep typing after Claude proposes. Block-id anchors + base hashes make rebase
  cheap and conflicts explicit. Never silently overwrite.
- **Channel security.** Broadcast channels are public by default; the surface channel must be
  private with an RLS policy on `realtime.messages`, or anyone with the anon key who guesses a user id
  could push `open_note` commands.
- **Client timeouts.** MCP clients time out long tool calls; cap long-polls at 55 s and set
  `maxDuration = 60`.
- **Tool schema weight.** 16 tools with terse descriptions. Resist re-growing to 27.
- **Consent UX for OAuth.** If Supabase's hosted consent page can't show the pairing code, pairing
  stays a separate step (it works either way; it's just one more click).
- **Elicitation** (server asks the user mid-call) is Claude Code-only today. Don't depend on it;
  the review bar is the confirmation surface everywhere.

---

## 12. Decisions I need from you

1. **First client.** Claude Code first (PAT works day one, OAuth in P2) — or do you need
   claude.ai / Desktop in P0, which pulls the Supabase OAuth server forward?
2. **In-app chat.** Adopt proposals there too, and turn `create_note` into `propose_new_note`?
   (Recommended: yes — one rule everywhere.)
3. **Colours.** I read "green or blue" as green = added, blue = removed. Keep blue for removals, or
   use conventional red?
4. **Review granularity.** Accept-all / Reject in P1, per-hunk in P2 — acceptable?
5. **Notes that aren't open.** Notify + badge (recommended) vs. auto-open the note when a proposal
   lands?
6. **SQL.** Typed tools only (recommended), or do you actually want a read-only SQL escape hatch in
   P3?
7. **Metadata.** Rename / retag / move as proposals in P2? Delete stays off the table?
8. **One-browser semantics.** Newest pairing wins, old window gets a banner (recommended) — or require
   an explicit disconnect first?
9. **Tool consolidation in chat.** OK to cut the in-app loop to the same 6 read tools, or keep the
   old 27 names there for now?
