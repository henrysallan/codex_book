# 02 — Reprocessing Strategy

The indexing pipeline must be **incremental** — editing a paragraph in a long document should reprocess only that one chunk, not the entire document. This doc describes the change-detection and partial-reindexing logic.

---

## Trigger: Document Save (Debounced)

The existing `DocumentEditor` already debounces saves (the editor has a sync-status indicator: synced → pending → saving → synced). The indexing pipeline hooks into the same save path but with additional debouncing:

- **Save to Supabase**: immediate (existing behaviour, ~2s debounce in editor).
- **Trigger indexing**: **30 seconds** after the last edit. This prevents reindexing on every keystroke while still keeping the index reasonably fresh.

Implementation: a `setTimeout`/`clearTimeout` in the save flow, or a background job queue that deduplicates by document ID.

---

## Step 1: Content Hash Comparison

On each indexing trigger:

1. Compute a hash of the full document content (`SHA-256` of the serialized BlockNote JSON).
2. Compare to the stored `content_hash` on the `documents` table.
3. If unchanged → **skip everything**. No API calls made.

This is the fast-path exit for documents that were opened but not modified.

---

## Step 2: Chunk Diffing

If the content hash has changed:

1. Run the chunker on the new content → produces `newChunks[]`.
2. Fetch existing chunks from `document_chunks` for this document.
3. Compare each chunk by its `content_hash`:

| Scenario | Action |
|----------|--------|
| Chunk hash matches an existing chunk | **Keep** — no reprocessing needed |
| Chunk hash is new (no match) | **New chunk** — run full pipeline (summary, tags, embedding) |
| Existing chunk hash has no match in new set | **Deleted** — remove from index |
| Chunk hash matches but `chunk_index` changed | **Moved** — update position only, no reprocessing |

### Matching Strategy

Chunks are matched by content hash, not by position. This correctly handles the case where a user inserts a new section in the middle — existing chunks below it shift position but their content hasn't changed, so they don't get reprocessed.

---

## Step 3: Selective Reprocessing

For each **new or modified** chunk:

1. Generate summary + tags (Groq Llama 8B)
2. Generate embedding (OpenAI text-embedding-3-small)
3. Upsert into `document_chunks`

For **deleted** chunks:

1. Delete from `document_chunks` (cascade handles the embedding)

---

## Step 4: Regenerate Document-Level Metadata

After chunk-level updates are complete:

1. Collect all chunk summaries (mix of existing + newly generated).
2. Regenerate document-level summary from chunk summaries.
3. Regenerate document-level tags from chunk summaries + chunk tags.
4. Regenerate document embedding from the new summary.
5. Update `documents.ai_summary`, `documents.ai_tags`, `documents.embedding`, `documents.content_hash`.

This step always runs when any chunk has changed, because the document summary depends on the full set of chunk summaries.

---

## Processing Status

Track indexing state per document so the UI can show status if desired:

| Status | Meaning |
|--------|---------|
| `idle` | Not queued for processing |
| `queued` | Waiting for debounce timer to fire |
| `processing` | Pipeline running |
| `indexed` | Up to date |
| `error` | Pipeline failed (will retry on next save) |

Stored in `documents.index_status` (text column, default `'idle'`).

---

## Error Handling

- If a chunk summary call fails, retry once, then mark the chunk as `index_status = 'error'` and continue with other chunks.
- If the embedding call fails, the chunk still has its summary and tags — it just won't appear in semantic search until reprocessed.
- Document-level summary/tags/embedding failure doesn't block chunk-level indexing.
- On next save, any errored chunks are automatically retried (they'll show as "modified" because they lack valid summaries/embeddings).

---

## Concurrency

- Only one indexing pipeline runs per document at a time. If a new save comes in while indexing is in progress, the new content is queued and processed after the current run completes.
- Multiple documents can be indexed in parallel (they don't share state).

---

## Cost Impact

For a typical edit (modifying 1-2 paragraphs in a 2,000-word document):

| Step | Calls | Cost |
|------|-------|------|
| Changed chunk summaries + tags | 1-2 × Groq 8B | ~$0.00 |
| Changed chunk embeddings | 1-2 × embedding | ~$0.00002 |
| Doc summary refresh | 1 × Groq 8B | ~$0.00 |
| Doc tags refresh | 1 × Groq 8B | ~$0.00 |
| Doc embedding refresh | 1 × embedding | ~$0.00002 |
| **Total** | | **< $0.0001** |

Incremental reprocessing keeps per-edit costs negligible.
