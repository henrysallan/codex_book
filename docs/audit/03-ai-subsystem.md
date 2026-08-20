# 03 — AI Subsystem

**Finding IDs:** `AI-C1` … `AI-L9`. Referenced elsewhere as "AI C1", etc.
**Scope:** `src/lib/ai/*`, `src/app/api/ai/*`, `ChatPanel.tsx` (SSE consumption), the save→index
trigger in `DocumentEditor.tsx`, and the relevant SQL. **AI-C1 was re-verified against source during
synthesis — the bug is real.**

---

## 1. SPEC

### 1.1 One chat message, end to end
**Entry:** `ChatPanel.sendMessage` → `POST /api/ai/chat`. Client assembles context items
client-side (folder items expand to *all* descendant docs with full `content` from the store cache,
avoiding server RLS); `tier` is forced to `GENERAL` (Research toggle) or `TIER2` ("Look deeper",
which resubmits **only the last user message**).

**Routing** ([router.ts](../../src/lib/ai/router.ts), always runs even under override):
1. **Affirmation resolution** — a bare "yes/ok/go ahead" inherits the last substantive prior query.
2. **Regex heuristics** (priority): `contextItemCount>0` → **CONTEXT**; TIER1 patterns → **TIER1**;
   TIER2 patterns → **TIER2**; TIER0 patterns (only if a doc is open) → **TIER0**; GENERAL patterns
   (guarded by a "my notes" anchor) → **GENERAL**; no doc + no context → **TIER1** default.
3. **Groq classifier** (`llama-3.1-8b-instant`, `max_tokens:4`) → tier; any error → TIER1.

**Retrieval + context**:

| Tier | Retrieval | Assembly | Cap |
|---|---|---|---|
| GENERAL | none | research prompt | — |
| TIER0 | active doc content (or DB) | full doc as plain text | 48k chars |
| TIER1 | parallel `embedQuery` + `keywordSearch`; `match_chunks` (thr 0.4, ≤5/doc); keyword→synthetic chunks; rerank → top 20 | chunk **summaries** grouped as `[Source N]` + sourceMap | 20 chunks |
| TIER2 | same, looser (thr 0.35, ≤6/doc); top 4 full docs + keyword fill up to 7 | **full document text** | 200k chars |
| CONTEXT | client-supplied content per item | each doc ≤40k chars | **no total cap** |

**Model selection:** `contextTokens < 10_000` → `claude-haiku-4-5-20251001`, else `claude-sonnet-4-6`
(overridable).

**SSE + tool loop** ([chat/route.ts](../../src/app/api/ai/chat/route.ts)): emit `meta`; loop
`round 0..5`; at `round>0` if estimated tokens > 35k send one forced-answer call and break; else
stream with `tools`; `stop_reason!=="tool_use"` → break; else emit `tool_use`, execute tools in
parallel, append messages, continue; finally `done`. `logUsage` fire-and-forget.

**Client** ([ChatPanel.tsx:233-292](../../src/components/ChatPanel.tsx#L233-L292)) reads the body,
splits each network chunk by `\n`, parses `data:` lines; on stream exception the partial is
**discarded** and replaced with an apology. An `AbortController` is created but `.abort()` is **never
called**.

### 1.2 Indexing pipeline
Content change → 1s debounce `saveDocument` → **30s debounce** `POST /api/ai/index` →
`indexDocument`: set `processing` → hash-diff (skip if unchanged) → chunk (headings = boundaries,
target 400 / max 600 tokens; oversized block kept **unsplit**) → summarize+tag new chunks (Groq) →
embed (OpenAI ×100 batch) → write chunks (**errors unchecked**) → doc-level summary/tags/embedding →
`content_hash` + `index_status='indexed'`. `index_status`: `idle → processing → indexed | error`.
**There is no "content changed, not yet reindexed" state** — a stale doc still reads `indexed`.

### 1.3 Tools (27, `tools.ts`)
26 read-only, 1 write. Read tools: `search_notes`, `get_document_info`, `read_document_content`,
`list_folder_contents`, `get_backlinks`, `search_by_date`, `get_writing_stats`, `search_by_tags`,
`get_folder_tree`, `count_documents`, `get_document_lengths`, `get_recent_documents`,
`get_document_children`, `get_all_tags`, `batch_get_document_info`, `get_chunk_summaries`,
`find_similar_documents`, `search_document_content`, `get_folder_info`, `get_orphan_documents`,
`get_annotations`, `get_daily_note`, `get_tag_graph`, `get_document_hierarchy`, `compare_documents`,
`get_recently_modified`. Write tool: **`create_note`** (inserts a `documents` row). All results
truncated to 8000 chars.

---

## 2. Findings

### CRITICAL

**AI-C1 — Round-5 tool-loop exhaustion silently swallows the answer.** *(Verified.)* The loop runs
`round 0..5`. If the 6th model call still ends with `stop_reason==="tool_use"`, the code **executes
the tools, appends assistant + tool_result messages, then the loop condition fails and control drops
straight to the `done` event** — no final model call is ever made with those results
([chat/route.ts:309-450](../../src/app/api/ai/chat/route.ts#L309-L450)). The stream ends after a
`tool_use` event with whatever preamble preceded it (often nothing), and `ChatPanel` saves an
empty/truncated message. The token-budget branch (`round>0`, >35k) correctly forces an answer — the
round-exhaustion path needs the same treatment. *Repro:* "Compare the lengths of everything in my
Classes folder and my Essays folder" → 6 tool rounds → blank reply.

**AI-C2 — Unchecked Supabase write errors + unconditional `content_hash` advance = permanent, invisible
index gaps.** Every write in the chunk-write step ignores the `{error}` return
([indexDocument.ts:200-257](../../src/lib/ai/indexDocument.ts#L200-L257)) — supabase-js does not
throw. If an insert fails (transient error, constraint, RLS under the anon fallback), execution
continues and the doc-level step still writes `content_hash=newHash`, `index_status='indexed'`. From
then on the hash short-circuit skips every future run — the missing chunks can never be repaired
except by `force` backfill, and nothing surfaces it.

**AI-C3 — AI routes unauthenticated + `search_documents` SECURITY DEFINER, no user filter.** See
[Security C4/C3](01-security.md). Any request reaching the deployment can burn spend, read any doc,
and `create_note`; the anon-callable search RPC leaks all users' content.

### HIGH

**AI-H1 — Server keeps generating (and paying) after client disconnect; no abort path at all.** The
route never inspects `req.signal`, the `ReadableStream` has no `cancel()`, and the Anthropic stream is
never `.abort()`ed. Closing the tab mid-answer → server keeps streaming into a dead controller and
runs up to 5 more tool rounds; the `enqueue` after cancel throws, the catch tries another `enqueue`
that throws again → unhandled rejection noise while Anthropic tokens are still billed. Client-side
`abortRef` is dead code — no Stop button, no unmount cleanup. (See [UI-M7](04-ui-editor.md).)

**AI-H2 — Client SSE parser has no cross-chunk line buffering — events straddling TCP reads are
dropped.** Each `reader.read()` chunk is split on `\n` independently; a `data:{...}` frame split
across two reads yields two unparseable fragments, both swallowed by `catch {}`. The `meta` event
(sourceMap → citations) or `done` can vanish under fragmentation. *Fix:* keep a residual buffer across
reads; parse only complete lines.

**AI-H3 — `groqLimited` sleeps 2.5s *before* resolving — adds 2.5s to every caller including the chat
router.** [groqLimiter.ts:26-31](../../src/lib/ai/groqLimiter.ts#L26-L31): `await fn(); await
sleep(2500); resolve()`. Every classifier-routed message waits an extra 2.5s before retrieval even
begins; each chunk/doc summary in indexing costs ≥2.5s wall time. The gap should be enforced *between*
queue items (resolve first, chain the sleep). Combined with `/api/ai/index`'s `maxDuration:120`, a doc
with >~40 changed chunks exceeds the limit → Vercel kills it → `index_status` stuck at `processing`
forever.

**AI-H4 — `groqLimiter` cannot protect the shared 30 RPM across serverless instances.** `_queue` is
module-level (per-lambda). Concurrent invocations on different instances (chat routing *while* an index
run proceeds is the normal case) each run their own 24-calls/min queue → combined 48+ RPM → 429s. The
backoff ignores Groq's `retry-after` and stalls the whole queue. Needs shared state (Upstash/Redis
token bucket) or provider-side queuing.

**AI-H5 — Router misroutes "What did I write about X?" to GENERAL — the user's notes are never
searched.** `TIER1_PATTERNS` lacks "write" (`written|said|noted|wrote|thought`), `NOTES_ANCHOR_RE`
has a duplicated `wrote|wrote` (evidently a typo for `write`), and `GENERAL_PATTERNS` matches
"what did …" → GENERAL, no retrieval. The system prompt then says "Answer from your own knowledge."
Tools *may* rescue it via `search_notes`, but the default is wrong.

**AI-H6 — Oversized single blocks are never split → embedding call throws → whole document fails to
index.** A block > 600 est-tokens becomes one unbounded chunk
([chunker.ts:187-197](../../src/lib/ai/chunker.ts#L187-L197)); one pasted wall-of-text beyond
~8,192 real tokens exceeds `text-embedding-3-small`'s per-input limit → `embeddings.create` rejects
the **whole batch** → `index_status='error'`, and every subsequent save fails identically until the
user manually splits the paragraph. The `words × 1.3` estimator also undercounts code/CJK/URL content.

**AI-H7 — Force backfill is destructive-first under a hard timeout.** `force:true` deletes **all
chunks for all selected docs** and nulls `content_hash` *before* the sequential re-index loop
([backfill/route.ts:96-140](../../src/app/api/ai/backfill/route.ts#L96-L140)). With `maxDuration:300`
and ≥2.5s/Groq call, only ~100 chunk summaries fit; a larger KB ends killed mid-loop — most docs left
with zero chunks, null hashes, some stuck `processing`. This is also the cost hot spot (re-embeds and
re-summarizes the entire corpus with no reuse). *Fix:* clear chunks per-document just before
re-indexing that document.

**AI-H8 — Stale index on tab close: the 30s trigger is fire-and-forget from the browser with no dirty
marker.** Indexing is only triggered by a `setTimeout(fetch…, 30_000)` in the editor. Close/navigate
within 30s → the trigger is gone; the DB has new content but old chunks, and `index_status` still says
`indexed`, so non-force backfill (`index_status.neq.indexed`) **skips** it. Staleness persists until
the next edit. *Fix:* mark `index_status='stale'` (or clear `content_hash`) inside `saveDocument`,
and/or send the trigger via `navigator.sendBeacon` on `visibilitychange`. Pairs with
[UI-H5](04-ui-editor.md).

### MEDIUM

`AI-M1` mid-stream failure discards the partial answer (ChatPanel:286-292). `AI-M2` chat can exceed
`maxDuration:120` on TIER2 multi-round → platform kill with no `error` event (feeds M1). `AI-M3`
CONTEXT tier is unbounded in aggregate (50 docs ≈ 500k tokens; the 35k budget check only runs at
`round>0`). `AI-M4` token estimation is inconsistent (`chars/4` vs `words×1.3` vs
`JSON.stringify/4`) and counts none of the ~27 tool defs → `selectModel` can pick Haiku for an
over-10k context. `AI-M5` retrieval errors return `[]` and read to the user as "you have no notes
about this"; if `embedQuery` throws, the whole request 500s even though keyword search alone could
serve TIER1. `AI-M6` duplicate chunk hashes within one doc orphan a row (Map keeps last). `AI-M7`
`truncateToolResult` emits **invalid JSON** for object-shaped results — `read_document_content`
(20k-char content always > the 8k cap) cuts mid-string every time. `AI-M8` the forced-answer budget
call omits `tools` while history still contains tool blocks → risks a 400. `AI-M9` `get_daily_note`'s
or-filter breaks on comma-containing titles (`March 14, 2025`). `AI-M10` the `fts` tsvector and
trigram indexes are built on **raw BlockNote JSON**, so `type`/`props`/block IDs pollute FTS and
trigram similarity is near-zero for real fuzzy hits — index a stripped-plaintext generated column
instead. `AI-M11` `logUsage` fires after `controller.close()` with no `waitUntil` → may be lost at
teardown. `AI-M12` failed chunk summaries are persisted as `""` and **re-paid every run** forever.
`AI-M13` title-only edits never refresh AI metadata (rename doesn't schedule indexing and wouldn't
change the hash).

### LOW

`AI-L1` model IDs are valid (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`) but `annotate/route.ts`
comment says "Haiku 3.5". `AI-L2` `match_annotations`/`AnnotationResult` are dead — annotation
embeddings are written, never queried. `AI-L3` TIER0 with client content labels it "Current Document",
losing the real title. `AI-L4` affirmation docs vs code drift (≤3 vs ≥4 words). `AI-L5` `create_note`
attribution + `single()` on empty table errors. `AI-L6` `handleLookDeeper` produces two consecutive
assistant replies in saved history. `AI-L7` list-item rendering inconsistent between chunker and
prompt. `AI-L8` no embedding model/version column — a `MODEL` change silently mixes vector spaces.
`AI-L9` IVFFlat indexes commented out → every `match_*` is a sequential scan.

---

## 3. Retrieval quality

**Scores are not commensurable.** `rerankChunks` mixes three incompatible quantities in one
`similarity` field: vector cosine (~0.35-0.65 for real hits), synthetic keyword ranks (title 1.0 /
tag 0.9 / folder 0.85), and FTS `ts_rank_cd` (~0.01-0.1, unbounded) or trigram similarity. With
`combined = 0.55·sim + 0.25·overlap + bonuses`, a mediocre title match (0.55) beats a strong semantic
hit (0.60×0.55 ≈ 0.33) almost every time, while genuine FTS body matches sink regardless of relevance.
The +0.05 real-chunk bonus is far too small to correct this.

**Other issues:** `overlapScore` uses raw `includes` ("art" matches "particular", "ethics"≠"ethical");
`phraseBonus` needs the entire query verbatim so it never fires for real questions; rerank scores
chunk **content** but TIER1 shows the model only chunk **summaries** (citations can point at text the
source doesn't visibly support); the FTS **snippet is discarded** during keyword merge; per-doc dedup
runs *before* rerank; TIER1's 0.4 cosine cutoff is aggressive for `text-embedding-3-small`.

**Quick wins (impact order):** (1) fix AI-H5's router regexes; (2) RRF or per-source normalization in
rerank; (3) pass FTS snippets into synthetic chunks; (4) strip BlockNote JSON out of the FTS/trigram
source (AI-M10); (5) rerank on summary+heading (what the model sees); (6) show the stored chunk
`heading` in TIER1 sections.
