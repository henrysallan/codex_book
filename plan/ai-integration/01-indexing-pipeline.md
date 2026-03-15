# 01 — Indexing Pipeline

The indexing pipeline transforms raw BlockNote document content into a structured intelligence layer: chunks, summaries, tags, and embeddings. It runs **asynchronously** after every meaningful document save — the user never waits for it.

---

## Pipeline Overview

```
Document saved
    │
    ▼
┌──────────┐    ┌────────────────┐    ┌──────────────┐    ┌───────────┐
│ Chunking │───▶│ Chunk Summaries│───▶│  Doc Summary  │───▶│ Embeddings│
│          │    │   + Chunk Tags │    │  + Doc Tags   │    │           │
└──────────┘    └────────────────┘    └──────────────┘    └───────────┘
```

Each step is described below.

---

## Step 1: Chunking

Split the document into **semantic chunks** that follow the document's own structure — not arbitrary character windows.

### Chunking Rules

| BlockNote Block Type | Chunking Behaviour |
|---------------------|--------------------|
| Heading + subsequent paragraphs | One chunk (heading is the chunk's "title") |
| Standalone paragraph | Chunk by itself, or merged with adjacent paragraphs if short |
| Bulleted / numbered list | Entire list is one chunk |
| Table / database block | One chunk per block |
| Code block | One chunk per block |
| Multi-column layout | Each column chunked independently |

### Target Size

- **300–500 tokens** per chunk.
- If a section exceeds ~500 tokens, split at the nearest paragraph boundary.
- If a section is under ~100 tokens, merge with the next adjacent chunk.

### Chunk Metadata

Each chunk record stores:

| Field | Description |
|-------|-------------|
| `id` | UUID |
| `document_id` | Parent document |
| `chunk_index` | Position within document (0-based) |
| `content` | Raw text content of the chunk |
| `content_hash` | SHA-256 of `content` — used for change detection |
| `heading` | Nearest heading above this chunk (nullable) |
| `block_ids` | Array of BlockNote block IDs this chunk spans |
| `token_count` | Approximate token count |

### Implementation Notes

- BlockNote stores content as a JSON tree of blocks. The chunker walks this tree, accumulating text into chunks based on block type boundaries.
- A utility function `blocksToChunks(blocks: Block[])` takes the parsed BlockNote JSON and returns `Chunk[]`.
- Token counting can use a fast approximation (word count × 1.3) — exact tokenization isn't needed.

---

## Step 2: Chunk Summaries + Chunk Tags

Each chunk gets a **1–2 sentence summary** and **2–3 tags** in a single LLM call.

### Model

**Groq — Llama 3.1 8B** (~30ms latency, effectively free at our volume).

### Prompt

```
You are summarizing a passage from a personal knowledge base.

<passage>
{chunk.content}
</passage>

Respond with JSON only:
{
  "summary": "1-2 sentence summary. Be specific — include names, concepts, and conclusions, not vague descriptions.",
  "tags": ["tag1", "tag2"]
}

Existing tags in this knowledge base (reuse these where possible):
{existingTagsList}

Rules for tags:
- 2-3 tags per chunk
- Lowercase, hyphenated (e.g. "real-time-sync", "client-work")
- Reuse existing tags before inventing new ones
- Be specific: "wittgenstein-language-games" not "philosophy"
```

### Output

Each chunk record is updated with:
- `summary` — 1–2 sentences
- `tags` — string array of 2–3 tags

### Batching

Process all chunks for a document in parallel (Promise.all) since they're independent. For a typical document of 5–10 chunks, this completes in <500ms via Groq.

---

## Step 3: Document-Level Summary

After all chunk summaries are generated, concatenate them and produce a **document-level summary** (2–3 sentences).

### Model

**Groq — Llama 3.1 8B**

### Prompt

```
Below are summaries of each section of a document titled "{document.title}".

{chunkSummaries.map((s, i) => `${i+1}. ${s}`).join('\n')}

Write a 2-3 sentence summary of the entire document. Capture the overall scope, main argument or topic, and any open questions or conclusions.

Respond with only the summary text, no JSON.
```

### Storage

Written to `documents.ai_summary` (new column, see [06-data-model.md](./06-data-model.md)).

### Uses

- Shown in search result previews
- Fed to Tier 1 retrieval for candidate filtering
- Used to generate the document-level embedding

---

## Step 4: Document-Level Tags

Generated alongside or immediately after the document summary.

### Model

**Groq — Llama 3.1 8B**

### Prompt

```
You are tagging a document from a personal knowledge base.

Document title: "{document.title}"
Document summary: "{document.ai_summary}"
Section tags: {allChunkTags (deduplicated)}

Generate 5-10 document-level tags. These are broader than section tags — include topic categories, project names, people, and technologies.

Existing tags in this knowledge base (reuse where possible):
{existingTagsList}

Respond with JSON only:
{
  "tags": ["tag1", "tag2", "tag3", ...]
}

Rules:
- Lowercase, hyphenated
- Reuse existing tags before inventing new ones
- Include chunk tags that are relevant to the whole document
- Add broader category tags the chunks might not have captured
```

### Storage

Written to `documents.ai_tags` (new JSONB array column). These are separate from the user's manual `tags` — they're AI-generated and used for retrieval filtering.

---

## Step 5: Embeddings

Two levels of embeddings, generated after summaries and tags are complete.

### Model

**OpenAI — text-embedding-3-small** (1536 dimensions, $0.02 / 1M tokens).

### Chunk Embeddings

Each chunk gets an embedding of its `content` text. Stored in `document_chunks.embedding`.

- These power semantic search — a query match tells you exactly which part of which document is relevant.

### Document Embeddings

One embedding per document, generated from the `ai_summary` (not the full text).

- The summary is a better semantic fingerprint because it's already distilled to core meaning.
- Stored in `documents.embedding`.

### Vector Storage

Supabase has native `pgvector` support. Embeddings are stored as `vector(1536)` columns with IVFFlat or HNSW indexes for fast similarity search.

---

## Cost Estimate Per Document

For a typical 2,000-word document (~8 chunks):

| Step | Calls | Cost |
|------|-------|------|
| Chunk summaries + tags | 8 × Groq 8B | ~$0.00 (free tier) |
| Document summary | 1 × Groq 8B | ~$0.00 |
| Document tags | 1 × Groq 8B | ~$0.00 |
| Chunk embeddings | 8 × embedding | ~$0.0001 |
| Document embedding | 1 × embedding | ~$0.00002 |
| **Total** | | **< $0.001** |

The indexing pipeline is effectively free to run.
