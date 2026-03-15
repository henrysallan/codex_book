# 07 — Implementation Steps

Ordered build plan. Each phase is independently deployable — earlier phases provide value even if later phases aren't finished.

---

## Phase 1: Foundation — API Routes & Database

**Goal:** Get the infrastructure in place so subsequent phases have something to plug into.

### Steps

1. **Run the database migration** ([06-data-model.md](./06-data-model.md))
   - Enable `pgvector` extension in Supabase
   - Create `document_chunks` table
   - Add new columns to `documents` and `annotations`
   - Create the `match_chunks`, `match_documents`, `match_annotations` functions
   - Create a single `supabase/ai_migration.sql` file with everything

2. **Add environment variables**
   - `GROQ_API_KEY` — for Llama 8B (summarization, tagging, routing)
   - `OPENAI_API_KEY` — for text-embedding-3-small
   - `ANTHROPIC_API_KEY` — for Haiku/Sonnet (chat responses)
   - Add to `.env.local` and document in README

3. **Create API route scaffolding**
   - `app/api/ai/chat/route.ts` — handles Flow 1 & 2 (streaming SSE)
   - `app/api/ai/annotate/route.ts` — handles Flow 3 (streaming SSE)
   - `app/api/ai/index/route.ts` — triggers indexing pipeline for a document
   - Each route should initially return a placeholder streaming response

4. **Add TypeScript types** ([06-data-model.md](./06-data-model.md#typescript-types))
   - `DbDocumentChunk`, `ChunkSearchResult`, `DocumentSearchResult`, `DbUsageLog` in `types.ts`

5. **Build the usage tracking helper** — `lib/ai/usage.ts`
   - `logUsage({ flow, provider, model, inputTokens, outputTokens, documentId? })` — inserts a row into `usage_logs`
   - Every API route calls this after the LLM response completes
   - For streaming responses, token counts come from the final stream event (Anthropic `message_delta`, Groq stream end)
   - This is wired in from day one so every call is tracked, including during development

### Deliverable

API routes exist and return stub responses. Database is ready. Every AI call is token-tracked from the start.

---

## Phase 2: Indexing Pipeline

**Goal:** Documents get automatically chunked, summarized, tagged, and embedded.

### Steps

1. **Build the chunker** — `lib/ai/chunker.ts`
   - Input: BlockNote JSON blocks
   - Output: `Chunk[]` with content, heading, block_ids, token_count
   - Unit test with sample BlockNote documents

2. **Build the summarizer/tagger** — `lib/ai/summarize.ts`
   - Groq API client (Llama 3.1 8B)
   - `summarizeChunk(content, existingTags)` → `{ summary, tags }`
   - `summarizeDocument(chunkSummaries, title)` → `{ summary, tags }`
   - Includes the controlled-vocabulary tag prompt

3. **Build the embedder** — `lib/ai/embed.ts`
   - OpenAI client for text-embedding-3-small
   - `embedTexts(texts: string[])` → `number[][]` (batched)
   - Handles rate limiting and retries

4. **Build the pipeline orchestrator** — `lib/ai/indexDocument.ts`
   - Combines chunker → summarizer → embedder
   - Implements the diff/reprocessing logic from [02-reprocessing.md](./02-reprocessing.md)
   - Updates `document_chunks` and `documents` tables
   - Handles errors gracefully (partial success is OK)

5. **Wire indexing into document save**
   - After `saveDocument` succeeds, trigger indexing via the API route
   - 30-second debounce to avoid re-indexing on every keystroke
   - Non-blocking — the save completes immediately, indexing runs in background

6. **Backfill existing documents**
   - A one-time script or admin action to index all existing documents
   - Can run via `app/api/ai/backfill/route.ts` (admin-only)

### Deliverable

Saving a document automatically indexes it. Chunks, summaries, tags, and embeddings populate in the database.

---

## Phase 3: Flow 3 — Annotation Chat (Quickest Win)

**Goal:** Replace the placeholder AI responses in `AnnotationChat` with real Haiku inference.

This is the **fastest path to a working AI feature** because the UI is already fully built.

### Steps

1. **Implement `/api/ai/annotate` route**
   - Accept annotation context (highlighted text, message history)
   - Fetch surrounding document content for context
   - Call Haiku 3.5 with assembled prompt
   - Stream response back via SSE

2. **Update `AnnotationChat` component**
   - Replace the `setTimeout` placeholder with a real API call
   - Stream tokens into the message as they arrive
   - Show a loading indicator while waiting
   - Handle errors gracefully

3. **Update store `addAnnotationMessage`**
   - After the AI response is complete, persist it to the annotation's messages array

4. **Annotation embedding** (can defer)
   - After 2+ messages, generate and store an embedding for the annotation thread
   - Makes annotations searchable in Flow 1

### Deliverable

Users can highlight text and have real AI conversations about it.

---

## Phase 4: Flow 1 — General Search Chat

**Goal:** The ChatPanel answers questions using tiered retrieval over the knowledge base.

### Steps

1. **Build the query router** — `lib/ai/router.ts`
   - Heuristic overrides (check context items, keywords)
   - Groq classifier for ambiguous queries
   - Returns `TIER0 | TIER1 | TIER2 | CONTEXT`

2. **Build retrieval functions** — `lib/ai/retrieve.ts`
   - `embedQuery(query)` → embedding vector
   - `retrieveChunks(embedding, options)` → ranked chunks with summaries
   - `retrieveDocuments(chunkResults)` → full document content for top matches
   - Uses the Supabase `match_chunks` / `match_documents` functions

3. **Build context assembler** — `lib/ai/context.ts`
   - `assembleTier0Context(document, query)` → formatted context string
   - `assembleTier1Context(chunkResults)` → formatted summaries
   - `assembleTier2Context(documents)` → formatted full documents
   - Each includes appropriate system prompt

4. **Implement `/api/ai/chat` route**
   - Route the query → select tier
   - Run retrieval for the selected tier
   - Assemble context → call LLM
   - Stream response back
   - Include metadata (tier used, documents referenced, cost estimate)

5. **Update `ChatPanel` component**
   - Replace placeholder responses with real streaming API calls
   - Render document citations as clickable links
   - Show "Look deeper →" button when response signals thin results
   - Show loading/streaming state

6. **Add "Look deeper" escalation**
   - Inline button that re-sends the query at Tier 2
   - Append the deeper response to the conversation

### Deliverable

Users can ask questions in the chat and get real answers drawn from their knowledge base.

---

## Phase 5: Flow 2 — Context Query

**Goal:** When users have documents pinned to context, the chat works with that explicit context.

### Steps

1. **Detect context mode in router**
   - If `contextItems.length > 0`, route to `CONTEXT`
   - Fetch full content for each context document

2. **Build context assembly for Flow 2**
   - Format all pinned documents/blocks into a system prompt
   - Select model based on total context size

3. **Multi-turn conversation handling**
   - Send full message history with each request
   - Context documents stay in system prompt across turns

4. **"Continue with context" transition from Flow 1**
   - After a Flow 1 response, offer to load cited documents as context
   - UI button that populates `contextItems` and switches to Flow 2 mode

### Deliverable

Full AI conversation with explicitly loaded documents.

---

## Phase 6: Polish & Extras

**Goal:** Quality-of-life improvements once the core flows work.

### Steps

1. **Cost dashboard UI** — query `usage_logs` to show per-flow, per-day, and per-document token/cost breakdowns in a settings panel (logging itself is in Phase 1)
2. **Conversation saving** — save Flow 2 conversations as linked annotations
3. **Annotation search integration** — annotation embeddings appear in Flow 1 results
4. **Tag browser** — UI to browse and filter by AI-generated tags
5. **Index status indicator** — show indexing state (queued/processing/indexed) per document
6. **Backfill progress** — UI for the one-time indexing of existing documents
7. **Model selection** — allow the user to override model choice in ChatPanel (the selector is already in the UI)

---

## Dependency Graph

```
Phase 1: Foundation
    │
    ├───▶ Phase 2: Indexing Pipeline
    │         │
    │         ├───▶ Phase 4: Flow 1 (Search) ───▶ Phase 5: Flow 2 (Context)
    │         │
    │         └───▶ Phase 6: Polish (annotation search, tag browser)
    │
    └───▶ Phase 3: Flow 3 (Annotation) — can start in parallel with Phase 2
                                          (doesn't need indexing to work)
```

**Phases 1 + 3 are the fastest path to a visible AI feature.** The annotation chat needs only an API key and a Haiku call — no indexing infrastructure required. Build that first, then layer in indexing and search.

---

## File Structure (New Files)

```
cortex/
  src/
    app/
      api/
        ai/
          chat/route.ts        # Flow 1 & 2
          annotate/route.ts    # Flow 3
          index/route.ts       # Trigger indexing
          backfill/route.ts    # One-time bulk index
    lib/
      ai/
        chunker.ts             # BlockNote → chunks
        summarize.ts           # Groq summarization & tagging
        embed.ts               # OpenAI embedding
        router.ts              # Query routing
        retrieve.ts            # Vector search & retrieval
        context.ts             # Context assembly for each tier
        indexDocument.ts       # Pipeline orchestrator
        usage.ts               # Token usage logging helper
  supabase/
    ai_migration.sql           # All new tables, columns, functions
```
