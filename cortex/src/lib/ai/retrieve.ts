/**
 * Retrieval — hybrid search (keyword + vector) over chunks and documents via Supabase.
 */

import { embedText } from "./embed";
import { getServerSupabase } from "@/lib/supabaseServer";

// ─── Types ───

export interface ChunkResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  summary: string | null;
  tags: string[];
  similarity: number;
}

export interface DocumentResult {
  id: string;
  title: string;
  content: string;
  ai_summary: string | null;
  ai_tags: string[];
  similarity: number;
}

export interface AnnotationResult {
  id: string;
  document_id: string;
  highlighted_text: string;
  summary: string;
  similarity: number;
}

export interface KeywordDocResult {
  id: string;
  title: string;
  folder_id: string | null;
  tags: string[];
  ai_summary: string | null;
  ai_tags: string[];
  rank: number;
  source: "fts" | "title" | "folder" | "tag";
}

// ─── Embed query ───

/**
 * Embed a user query for vector search.
 */
export async function embedQuery(query: string): Promise<number[]> {
  return embedText(query, { flow: "chat-embed" });
}

// ─── Chunk retrieval (Tier 1 & 2) ───

/**
 * Search for relevant chunks via cosine similarity.
 * Returns chunks ordered by similarity, deduped to limit per-document flooding.
 */
export async function retrieveChunks(
  queryEmbedding: number[],
  options?: {
    threshold?: number;
    count?: number;
    maxPerDocument?: number;
  }
): Promise<ChunkResult[]> {
  const supabase = getServerSupabase();
  if (!supabase) return [];

  const threshold = options?.threshold ?? 0.4;
  const count = options?.count ?? 25;
  const maxPerDoc = options?.maxPerDocument ?? 5;

  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_threshold: threshold,
    match_count: count,
  });

  if (error) {
    console.error("[retrieve] match_chunks error:", error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Deduplicate: limit chunks per document to prevent one verbose doc from flooding
  const docCounts = new Map<string, number>();
  const deduped: ChunkResult[] = [];

  for (const chunk of data as ChunkResult[]) {
    const currentCount = docCounts.get(chunk.document_id) ?? 0;
    if (currentCount < maxPerDoc) {
      deduped.push(chunk);
      docCounts.set(chunk.document_id, currentCount + 1);
    }
  }

  return deduped;
}

// ─── Document retrieval (Tier 2) ───

/**
 * Given chunk search results, fetch full content of the top N most relevant documents.
 * Deduplicates by document_id and ranks by best chunk similarity.
 */
export async function retrieveDocuments(
  chunkResults: ChunkResult[],
  options?: { maxDocuments?: number }
): Promise<DocumentResult[]> {
  const supabase = getServerSupabase();
  if (!supabase) return [];
  if (chunkResults.length === 0) return [];

  const maxDocs = options?.maxDocuments ?? 4;

  // Rank documents by their best chunk similarity
  const docBestSimilarity = new Map<string, number>();
  for (const chunk of chunkResults) {
    const current = docBestSimilarity.get(chunk.document_id) ?? 0;
    if (chunk.similarity > current) {
      docBestSimilarity.set(chunk.document_id, chunk.similarity);
    }
  }

  // Sort by best similarity and take top N
  const topDocIds = [...docBestSimilarity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxDocs)
    .map(([id]) => id);

  // Fetch full document content
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, content, ai_summary, ai_tags")
    .in("id", topDocIds);

  if (error) {
    console.error("[retrieve] Error fetching documents:", error);
    return [];
  }

  if (!data) return [];

  // Return in similarity order
  return topDocIds
    .map((docId) => {
      const doc = data.find((d: { id: string }) => d.id === docId);
      if (!doc) return null;
      return {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        ai_summary: doc.ai_summary,
        ai_tags: doc.ai_tags ?? [],
        similarity: docBestSimilarity.get(docId) ?? 0,
      } as DocumentResult;
    })
    .filter((d): d is DocumentResult => d !== null);
}

// ─── Fetch a single document (Tier 0) ───

/**
 * Fetch the full content of a single document by ID.
 */
export async function fetchDocumentContent(
  documentId: string
): Promise<{ title: string; content: string } | null> {
  const supabase = getServerSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("documents")
    .select("title, content")
    .eq("id", documentId)
    .single();

  if (error || !data) return null;
  return { title: data.title, content: data.content };
}

// ─── Fetch context items (CONTEXT tier / Flow 2) ───

export interface ContextDocument {
  id: string;
  title: string;
  content: string;
}

/**
 * Fetch full content for a list of document IDs (used in CONTEXT tier).
 */
export async function fetchContextDocuments(
  docIds: string[]
): Promise<ContextDocument[]> {
  const supabase = getServerSupabase();
  if (!supabase) {
    console.error("[retrieve] fetchContextDocuments: server Supabase is null");
    return [];
  }
  if (docIds.length === 0) {
    console.warn("[retrieve] fetchContextDocuments: called with empty docIds");
    return [];
  }

  console.log(`[retrieve] fetchContextDocuments: querying ${docIds.length} docs:`, docIds);

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, content")
    .in("id", docIds);

  if (error) {
    console.error("[retrieve] fetchContextDocuments error:", error);
    return [];
  }
  if (!data || data.length === 0) {
    console.warn("[retrieve] fetchContextDocuments: query returned no rows for ids:", docIds);
    return [];
  }

  console.log(
    `[retrieve] fetchContextDocuments: got ${data.length} docs:`,
    data.map((d: ContextDocument) => ({ id: d.id, title: d.title, contentLen: d.content?.length ?? 0 }))
  );
  return data as ContextDocument[];
}

// ─── Keyword / Full-text search ───

/**
 * Extract meaningful keywords from a user query by removing stop words.
 * Returns lowercased keywords of 3+ characters.
 */
function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could",
    "i", "me", "my", "mine", "we", "us", "our", "ours",
    "you", "your", "yours", "he", "him", "his", "she", "her", "hers",
    "it", "its", "they", "them", "their", "theirs",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
    "this", "that", "these", "those",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either", "neither",
    "of", "in", "to", "for", "with", "on", "at", "from", "by", "about",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "then", "once",
    "all", "each", "every", "no", "any", "some", "such",
    "know", "tell", "show", "find", "search", "look", "get", "give",
    "notes", "note", "document", "documents", "file", "files", "anything",
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

/**
 * Run all keyword search strategies in parallel and merge results.
 *
 * Strategies:
 * 1. Full-text search via `search_documents` RPC (title/subtitle/content tsvector)
 * 2. Title ilike — matches any keyword in document title
 * 3. Folder name ilike — finds docs inside folders matching any keyword
 * 4. AI-tag overlap — finds docs tagged with any keyword
 */
export async function keywordSearch(query: string): Promise<KeywordDocResult[]> {
  const supabase = getServerSupabase();
  if (!supabase) return [];

  const keywords = extractKeywords(query);
  console.log("[retrieve] keywordSearch keywords:", keywords);
  if (keywords.length === 0) return [];

  const [ftsResults, titleResults, folderResults, tagResults] = await Promise.all([
    // ── 1. Full-text search (tsvector on title + subtitle + content) ──
    (async (): Promise<KeywordDocResult[]> => {
      try {
        const { data, error } = await supabase.rpc("search_documents", {
          search_query: query,
        });
        if (error) {
          console.error("[retrieve] FTS search_documents error:", error);
          return [];
        }
        if (!data || data.length === 0) return [];
        return (data as {
          id: string; title: string; folder_id: string | null;
          tags: string[]; rank: number;
        }[]).map((d) => ({
          id: d.id,
          title: d.title,
          folder_id: d.folder_id,
          tags: d.tags ?? [],
          ai_summary: null,
          ai_tags: [],
          rank: d.rank,
          source: "fts" as const,
        }));
      } catch (e) {
        console.error("[retrieve] FTS exception:", e);
        return [];
      }
    })(),

    // ── 2. Title ilike (any keyword matches) ──
    (async (): Promise<KeywordDocResult[]> => {
      try {
        const orFilter = keywords.map((k) => `title.ilike.%${k}%`).join(",");
        const { data, error } = await supabase
          .from("documents")
          .select("id, title, folder_id, tags, ai_summary, ai_tags")
          .or(orFilter)
          .limit(15);
        if (error || !data) return [];
        return (data as {
          id: string; title: string; folder_id: string | null;
          tags: string[]; ai_summary: string | null; ai_tags: string[];
        }[]).map((d) => ({
          id: d.id,
          title: d.title,
          folder_id: d.folder_id,
          tags: d.tags ?? [],
          ai_summary: d.ai_summary ?? null,
          ai_tags: d.ai_tags ?? [],
          rank: 1.0, // Title match is high-confidence
          source: "title" as const,
        }));
      } catch (e) {
        console.error("[retrieve] Title search exception:", e);
        return [];
      }
    })(),

    // ── 3. Folder name → docs inside matching folders ──
    (async (): Promise<KeywordDocResult[]> => {
      try {
        const orFilter = keywords.map((k) => `name.ilike.%${k}%`).join(",");
        const { data: folders, error: fErr } = await supabase
          .from("folders")
          .select("id, name")
          .or(orFilter)
          .limit(10);
        if (fErr || !folders || folders.length === 0) return [];

        const folderIds = folders.map((f: { id: string }) => f.id);
        const { data: docs, error: dErr } = await supabase
          .from("documents")
          .select("id, title, folder_id, tags, ai_summary, ai_tags")
          .in("folder_id", folderIds)
          .limit(25);
        if (dErr || !docs) return [];

        return (docs as {
          id: string; title: string; folder_id: string | null;
          tags: string[]; ai_summary: string | null; ai_tags: string[];
        }[]).map((d) => ({
          id: d.id,
          title: d.title,
          folder_id: d.folder_id,
          tags: d.tags ?? [],
          ai_summary: d.ai_summary ?? null,
          ai_tags: d.ai_tags ?? [],
          rank: 0.85, // Folder match — slightly less than direct title match
          source: "folder" as const,
        }));
      } catch (e) {
        console.error("[retrieve] Folder search exception:", e);
        return [];
      }
    })(),

    // ── 4. AI-tag overlap ──
    (async (): Promise<KeywordDocResult[]> => {
      try {
        // Try both lowercase and capitalised variants
        const tagVariants = [
          ...keywords,
          ...keywords.map((k) => k.charAt(0).toUpperCase() + k.slice(1)),
        ];
        const { data, error } = await supabase
          .from("documents")
          .select("id, title, folder_id, tags, ai_summary, ai_tags")
          .overlaps("ai_tags", tagVariants)
          .limit(15);
        if (error || !data) return [];
        return (data as {
          id: string; title: string; folder_id: string | null;
          tags: string[]; ai_summary: string | null; ai_tags: string[];
        }[]).map((d) => ({
          id: d.id,
          title: d.title,
          folder_id: d.folder_id,
          tags: d.tags ?? [],
          ai_summary: d.ai_summary ?? null,
          ai_tags: d.ai_tags ?? [],
          rank: 0.9, // Tag match — high relevance
          source: "tag" as const,
        }));
      } catch (e) {
        console.error("[retrieve] Tag search exception:", e);
        return [];
      }
    })(),
  ]);

  // ── Merge & deduplicate ──
  // Keep highest-rank entry per document; title > tag > folder > fts priority
  const docMap = new Map<string, KeywordDocResult>();

  for (const results of [titleResults, tagResults, folderResults, ftsResults]) {
    for (const result of results) {
      const existing = docMap.get(result.id);
      if (!existing || result.rank > existing.rank) {
        docMap.set(result.id, result);
      }
    }
  }

  const merged = [...docMap.values()].sort((a, b) => b.rank - a.rank);
  console.log(
    `[retrieve] keywordSearch: ${merged.length} docs (fts=${ftsResults.length}, title=${titleResults.length}, folder=${folderResults.length}, tag=${tagResults.length})`
  );
  return merged;
}

// ─── Hybrid helpers ───

/**
 * Convert keyword document results to synthetic ChunkResults for Tier 1 assembly.
 * Uses the document's ai_summary (or title as fallback) as the chunk summary.
 */
export function keywordResultsToChunks(
  kwResults: KeywordDocResult[],
  existingDocIds: Set<string>
): ChunkResult[] {
  return kwResults
    .filter((kr) => !existingDocIds.has(kr.id))
    .map((kr) => ({
      id: `kw-${kr.id}`,
      document_id: kr.id,
      chunk_index: -1, // sentinel: this is a keyword match, not a real chunk
      content: kr.ai_summary ?? kr.title,
      summary:
        kr.ai_summary ??
        `Document: "${kr.title}"${
          kr.ai_tags.length > 0 ? ` [${kr.ai_tags.join(", ")}]` : ""
        }`,
      tags: kr.ai_tags.length > 0 ? kr.ai_tags : kr.tags,
      similarity: kr.rank,
    }));
}

/**
 * Fetch full documents by IDs, returning DocumentResult[] (for Tier 2 merging).
 */
export async function fetchDocumentsById(
  docIds: string[]
): Promise<DocumentResult[]> {
  const supabase = getServerSupabase();
  if (!supabase || docIds.length === 0) return [];

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, content, ai_summary, ai_tags")
    .in("id", docIds);

  if (error || !data) return [];

  return (data as {
    id: string; title: string; content: string;
    ai_summary: string | null; ai_tags: string[];
  }[]).map((d) => ({
    id: d.id,
    title: d.title,
    content: d.content,
    ai_summary: d.ai_summary ?? null,
    ai_tags: d.ai_tags ?? [],
    similarity: 0.8, // Keyword-sourced — high but below vector top hits
  }));
}

// ─── Fetch document titles (lightweight) ───

/**
 * Fetch just the titles for a list of document IDs.
 * Used to build sourceMap labels for Tier 1 chunk results.
 */
export async function fetchDocumentTitles(
  docIds: string[]
): Promise<Map<string, string>> {
  const supabase = getServerSupabase();
  if (!supabase || docIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("documents")
    .select("id, title")
    .in("id", docIds);

  if (error || !data) return new Map();

  const map = new Map<string, string>();
  for (const d of data as { id: string; title: string }[]) {
    map.set(d.id, d.title);
  }
  return map;
}
