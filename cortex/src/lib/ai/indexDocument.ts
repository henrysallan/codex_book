/**
 * indexDocument — the full indexing pipeline orchestrator.
 *
 * 1. Fetch document content & compare content_hash
 * 2. Chunk the document
 * 3. Diff new chunks against existing chunks by content_hash
 * 4. Summarize + tag new/changed chunks
 * 5. Embed new/changed chunks
 * 6. Regenerate document-level summary, tags, embedding
 * 7. Update index_status
 */

import { createHash } from "crypto";
import { getServerSupabase } from "@/lib/supabaseServer";
import { blocksToChunks, Chunk } from "./chunker";
import { summarizeChunk, summarizeDocument, tagDocument } from "./summarize";
import { embedTexts, embedText } from "./embed";

// ─── Types ───

interface ExistingChunk {
  id: string;
  chunk_index: number;
  content_hash: string;
  summary: string | null;
  tags: string[];
}

export interface IndexResult {
  status: "skipped" | "indexed" | "error";
  documentId: string;
  chunksTotal: number;
  chunksNew: number;
  chunksKept: number;
  chunksDeleted: number;
  error?: string;
}

// ─── Helpers ───

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Fetch the existing tag vocabulary from the database for controlled tag generation.
 */
async function fetchExistingTags(): Promise<string[]> {
  const supabase = getServerSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("get_all_tags");
    if (error || !data) return [];
    return Array.isArray(data) ? data.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ─── Main Pipeline ───

export async function indexDocument(documentId: string): Promise<IndexResult> {
  const supabase = getServerSupabase();
  if (!supabase) {
    return {
      status: "skipped",
      documentId,
      chunksTotal: 0,
      chunksNew: 0,
      chunksKept: 0,
      chunksDeleted: 0,
      error: "Server-side Supabase not configured",
    };
  }

  // Mark as processing
  await supabase
    .from("documents")
    .update({ index_status: "processing" })
    .eq("id", documentId);

  try {
    // ── Step 1: Fetch document ──

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, title, content, content_hash")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const newHash = sha256(doc.content);

    // Skip if content hasn't changed
    if (doc.content_hash === newHash) {
      await supabase
        .from("documents")
        .update({ index_status: "indexed" })
        .eq("id", documentId);

      return {
        status: "skipped",
        documentId,
        chunksTotal: 0,
        chunksNew: 0,
        chunksKept: 0,
        chunksDeleted: 0,
      };
    }

    // ── Step 2: Chunk the document ──

    const newChunks = blocksToChunks(doc.content);
    if (newChunks.length === 0) {
      // Empty document — clean up any existing chunks
      await supabase
        .from("document_chunks")
        .delete()
        .eq("document_id", documentId);
      await supabase
        .from("documents")
        .update({
          content_hash: newHash,
          ai_summary: null,
          ai_tags: [],
          embedding: null,
          index_status: "indexed",
        })
        .eq("id", documentId);

      return {
        status: "indexed",
        documentId,
        chunksTotal: 0,
        chunksNew: 0,
        chunksKept: 0,
        chunksDeleted: 0,
      };
    }

    // Hash each new chunk
    const newChunkHashes = newChunks.map((c) => sha256(c.content));

    // ── Step 3: Diff against existing chunks ──

    const { data: existingChunks } = await supabase
      .from("document_chunks")
      .select("id, chunk_index, content_hash, summary, tags")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });

    const existing: ExistingChunk[] = existingChunks ?? [];
    const existingByHash = new Map(existing.map((c) => [c.content_hash, c]));

    // Classify each new chunk
    const toProcess: { chunk: Chunk; index: number; hash: string }[] = [];
    const kept: { existingId: string; newIndex: number }[] = [];

    for (let i = 0; i < newChunks.length; i++) {
      const hash = newChunkHashes[i];
      const match = existingByHash.get(hash);
      if (match && match.summary) {
        // Content unchanged and already summarized — keep it
        kept.push({ existingId: match.id, newIndex: i });
        existingByHash.delete(hash); // consume the match
      } else {
        // New or modified — needs processing
        toProcess.push({ chunk: newChunks[i], index: i, hash });
      }
    }

    // Remaining existing chunks not matched = deleted
    const deletedIds = [...existingByHash.values()].map((c) => c.id);

    // ── Step 4: Summarize + tag new chunks ──

    const existingTags = await fetchExistingTags();

    const summaryResults = await Promise.all(
      toProcess.map(({ chunk }) =>
        summarizeChunk(chunk.content, existingTags, documentId)
      )
    );

    // ── Step 5: Embed new chunks ──

    let newEmbeddings: number[][] = [];
    if (toProcess.length > 0) {
      newEmbeddings = await embedTexts(
        toProcess.map(({ chunk }) => chunk.content),
        { flow: "index-embed-chunks", documentId }
      );
    }

    // ── Step 6: Write to database ──

    // Delete removed chunks
    if (deletedIds.length > 0) {
      await supabase
        .from("document_chunks")
        .delete()
        .in("id", deletedIds);
    }

    // Update kept chunks (just fix the chunk_index if it moved)
    for (const { existingId, newIndex } of kept) {
      await supabase
        .from("document_chunks")
        .update({ chunk_index: newIndex })
        .eq("id", existingId);
    }

    // Upsert new/changed chunks
    for (let i = 0; i < toProcess.length; i++) {
      const { chunk, index, hash } = toProcess[i];
      const { summary, tags } = summaryResults[i];
      const embedding = newEmbeddings[i] ?? null;

      // Try to find an existing chunk with this hash that had no summary (needs reprocessing)
      const existingMatch = existing.find(
        (e) => e.content_hash === hash && !e.summary
      );

      if (existingMatch) {
        // Update existing record
        await supabase
          .from("document_chunks")
          .update({
            chunk_index: index,
            content: chunk.content,
            heading: chunk.heading,
            block_ids: chunk.blockIds,
            token_count: chunk.tokenCount,
            summary,
            tags,
            embedding: embedding ? `[${embedding.join(",")}]` : null,
          })
          .eq("id", existingMatch.id);
      } else {
        // Insert new chunk
        await supabase.from("document_chunks").insert({
          document_id: documentId,
          chunk_index: index,
          content: chunk.content,
          content_hash: hash,
          heading: chunk.heading,
          block_ids: chunk.blockIds,
          token_count: chunk.tokenCount,
          summary,
          tags,
          embedding: embedding ? `[${embedding.join(",")}]` : null,
        });
      }
    }

    // ── Step 7: Regenerate document-level summary, tags, embedding ──

    // Collect all chunk summaries (kept + new)
    const allSummaries: { index: number; summary: string }[] = [];

    // From kept chunks, we need to read their summaries
    if (kept.length > 0) {
      const { data: keptChunks } = await supabase
        .from("document_chunks")
        .select("chunk_index, summary")
        .in("id", kept.map((k) => k.existingId));
      if (keptChunks) {
        for (const c of keptChunks) {
          if (c.summary) allSummaries.push({ index: c.chunk_index, summary: c.summary });
        }
      }
    }

    // From newly processed chunks
    for (let i = 0; i < toProcess.length; i++) {
      if (summaryResults[i].summary) {
        allSummaries.push({ index: toProcess[i].index, summary: summaryResults[i].summary });
      }
    }

    // Sort by chunk index for coherent document summary
    allSummaries.sort((a, b) => a.index - b.index);
    const orderedSummaries = allSummaries.map((s) => s.summary);

    // Generate document summary
    const docSummary = await summarizeDocument(
      doc.title,
      orderedSummaries,
      documentId
    );

    // Generate document tags
    const allChunkTags = [
      ...summaryResults.flatMap((r) => r.tags),
      ...kept
        .map((k) => existing.find((e) => e.id === k.existingId))
        .filter(Boolean)
        .flatMap((e) => e!.tags),
    ];
    const docTags = await tagDocument(
      doc.title,
      docSummary,
      allChunkTags,
      existingTags,
      documentId
    );

    // Generate document embedding from summary
    let docEmbedding: number[] | null = null;
    if (docSummary) {
      docEmbedding = await embedText(docSummary, {
        flow: "index-embed-doc",
        documentId,
      });
    }

    // ── Step 8: Update document metadata ──

    await supabase
      .from("documents")
      .update({
        content_hash: newHash,
        ai_summary: docSummary || null,
        ai_tags: docTags,
        embedding: docEmbedding ? `[${docEmbedding.join(",")}]` : null,
        index_status: "indexed",
      })
      .eq("id", documentId);

    return {
      status: "indexed",
      documentId,
      chunksTotal: newChunks.length,
      chunksNew: toProcess.length,
      chunksKept: kept.length,
      chunksDeleted: deletedIds.length,
    };
  } catch (err) {
    console.error(`[indexDocument] Error indexing ${documentId}:`, err);

    // Mark as error
    await supabase
      .from("documents")
      .update({ index_status: "error" })
      .eq("id", documentId);

    return {
      status: "error",
      documentId,
      chunksTotal: 0,
      chunksNew: 0,
      chunksKept: 0,
      chunksDeleted: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
