/**
 * Context Assembler — builds system prompts and context strings
 * for each retrieval tier.
 */

import type { ChunkResult, DocumentResult, ContextDocument } from "./retrieve";
import type { SourceMap } from "@/lib/types";

// ─── Shared base prompt ───

const BASE_SYSTEM = `You are Cortex, an AI assistant embedded in a note-taking and knowledge management app. You help users understand, search, and work with their notes.

Guidelines:
- Be concise and direct. Don't repeat what the user already knows.
- Use markdown formatting where appropriate.
- When referencing specific documents, mention them by title.
- If you're unsure or the provided context doesn't contain an answer, say so honestly.
- Don't make up information that isn't in the provided context.`;

// ─── Token estimation ───

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Tier 0: Current document ───

/**
 * Build context for Tier 0 (current document Q&A).
 * The full document content is provided as context.
 */
export function assembleTier0Context(
  document: { title: string; content: string },
  _query: string
): { systemPrompt: string; contextTokens: number } {
  // Convert BlockNote JSON to readable text
  const plainText = blocksToPlainText(document.content);

  // Cap at ~12K tokens (~48K chars) for Haiku
  const trimmed = plainText.slice(0, 48_000);

  const systemPrompt = `${BASE_SYSTEM}

The user is currently editing the following document and is asking a question about it.

## Document: "${document.title}"
---
${trimmed}
---

Answer the user's question based on this document. If the answer isn't in the document, say so.`;

  return {
    systemPrompt,
    contextTokens: estimateTokens(systemPrompt),
  };
}

// ─── Tier 1: Summary scan ───

/**
 * Build context for Tier 1 (summary scan across knowledge base).
 * Uses chunk summaries rather than full content.
 */
export function assembleTier1Context(
  chunkResults: ChunkResult[],
  docTitles?: Map<string, string>
): { systemPrompt: string; contextTokens: number; documentIds: string[]; sourceMap: SourceMap } {
  if (chunkResults.length === 0) {
    return {
      systemPrompt: `${BASE_SYSTEM}

I searched the user's knowledge base but found no relevant results. Let the user know and suggest they try rephrasing their question or searching for specific terms.`,
      contextTokens: estimateTokens(BASE_SYSTEM) + 50,
      documentIds: [],
      sourceMap: {},
    };
  }

  // Group chunks by document for cleaner presentation
  const byDoc = new Map<string, ChunkResult[]>();
  for (const chunk of chunkResults) {
    const existing = byDoc.get(chunk.document_id) ?? [];
    existing.push(chunk);
    byDoc.set(chunk.document_id, existing);
  }

  const sections: string[] = [];
  const documentIds: string[] = [];
  const sourceMap: SourceMap = {};
  let sourceNum = 1;

  for (const [docId, chunks] of byDoc) {
    documentIds.push(docId);

    // Get title from titleMap, keyword result summary, or fallback
    const docTitle = docTitles?.get(docId) ?? `Document ${sourceNum}`;
    sourceMap[sourceNum] = { docId, title: docTitle };

    const allTags = chunks.flatMap((c) => c.tags).filter(Boolean);
    const tagStr = allTags.length > 0 ? ` (${[...new Set(allTags)].join(", ")})` : "";
    const chunkSummaries = chunks.map((chunk) => {
      const summary = chunk.summary ?? chunk.content.slice(0, 200);
      return `  - ${summary}`;
    }).join("\n");

    sections.push(
      `[Source ${sourceNum}]${tagStr}\n${chunkSummaries}`
    );
    sourceNum++;
  }

  const resultsText = sections.join("\n\n");

  const systemPrompt = `${BASE_SYSTEM}

I searched the user's knowledge base and found the following relevant sections. These are summaries of document chunks, not the full text.

## Search Results

${resultsText}

---

Instructions:
- Answer the user's question using the search results above.
- ALWAYS cite your sources using bracket notation like [1], [2], etc. corresponding to the [Source N] labels above. Place citations at the end of the relevant sentence or claim.
- If the summaries aren't detailed enough to fully answer the question, say something like "I found some relevant notes but may need to look deeper for a complete answer." This signals the user can escalate to a deeper search.
- Do NOT invent details that aren't in the summaries.`;

  return {
    systemPrompt,
    contextTokens: estimateTokens(systemPrompt),
    documentIds,
    sourceMap,
  };
}

// ─── Tier 2: Full document content ───

/**
 * Build context for Tier 2 (full document retrieval).
 * Includes complete document content for the top matches.
 */
export function assembleTier2Context(
  documents: DocumentResult[]
): { systemPrompt: string; contextTokens: number; documentIds: string[]; sourceMap: SourceMap } {
  if (documents.length === 0) {
    return {
      systemPrompt: `${BASE_SYSTEM}

I searched the user's knowledge base deeply but found no relevant documents. Let the user know and suggest they try different search terms.`,
      contextTokens: estimateTokens(BASE_SYSTEM) + 50,
      documentIds: [],
      sourceMap: {},
    };
  }

  const documentIds = documents.map((d) => d.id);
  const sourceMap: SourceMap = {};

  // Build full-content sections, capping total at ~50K tokens
  const MAX_TOTAL_CHARS = 200_000; // ~50K tokens
  let totalChars = 0;
  const sections: string[] = [];

  documents.forEach((doc, idx) => {
    const sourceNum = idx + 1;
    sourceMap[sourceNum] = { docId: doc.id, title: doc.title };

    const plainText = blocksToPlainText(doc.content);
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) return;

    const trimmed = plainText.slice(0, remaining);
    totalChars += trimmed.length;

    sections.push(
      `=== [Source ${sourceNum}] "${doc.title}" ===\n${trimmed}`
    );
  });

  const docsText = sections.join("\n\n");

  const systemPrompt = `${BASE_SYSTEM}

I performed a deep search of the user's knowledge base. Here are the most relevant documents in full:

${docsText}

---

Instructions:
- Answer the user's question thoroughly using the full document content above.
- ALWAYS cite your sources using bracket notation like [1], [2], etc. corresponding to the [Source N] labels above. Place citations at the end of the relevant sentence or claim.
- You have the complete text, so provide detailed and accurate answers.
- If the documents don't contain the answer, say so honestly.`;

  return {
    systemPrompt,
    contextTokens: estimateTokens(systemPrompt),
    documentIds,
    sourceMap,
  };
}

// ─── CONTEXT tier (Flow 2): User-pinned documents ───

export interface ContextItem {
  type: "document" | "block";
  docId?: string;
  blockId?: string;
  text?: string;
  title?: string;
  /** Document content provided by the client (avoids server-side DB fetch / RLS issues) */
  content?: string;
}

/**
 * Build context for CONTEXT tier (explicit user-pinned documents/blocks).
 */
export function assembleContextTierContext(
  documents: ContextDocument[],
  blockItems: ContextItem[]
): { systemPrompt: string; contextTokens: number; sourceMap: SourceMap } {
  const sections: string[] = [];
  const sourceMap: SourceMap = {};
  let sourceNum = 1;

  for (const doc of documents) {
    sourceMap[sourceNum] = { docId: doc.id, title: doc.title };
    const plainText = blocksToPlainText(doc.content);
    // Cap each document at ~40K chars
    const trimmed = plainText.slice(0, 40_000);
    sections.push(
      `=== [Source ${sourceNum}] "${doc.title}" ===\n${trimmed}`
    );
    sourceNum++;
  }

  for (const block of blockItems) {
    if (block.text) {
      sections.push(
        `=== Block from "${block.title ?? "Unknown"}" ===\n"${block.text}"`
      );
    }
  }

  const contextText = sections.join("\n\n");

  const systemPrompt = `${BASE_SYSTEM}

The user has explicitly loaded the following documents/blocks into context to discuss:

${contextText}

---

Instructions:
- The user wants to discuss the content above. Answer their questions based on this context.
- ALWAYS cite your sources using bracket notation like [1], [2], etc. corresponding to the [Source N] labels above. Place citations at the end of the relevant sentence or claim.
- This is an ongoing conversation — maintain context across messages.
- If asked to write, edit, or synthesize based on these documents, do so directly.`;

  return {
    systemPrompt,
    contextTokens: estimateTokens(systemPrompt),
    sourceMap,
  };
}

// ─── Model selection ───

/**
 * Select the appropriate Anthropic model based on context size.
 * <10K tokens → Haiku (fast, cheap)
 * 10K+ tokens → Sonnet (better reasoning for large contexts)
 */
export function selectModel(contextTokens: number): string {
  if (contextTokens < 10_000) {
    return "claude-haiku-4-5-20251001";
  }
  return "claude-sonnet-4-6";
}

// ─── BlockNote JSON → Plain Text ───

/**
 * Convert BlockNote JSON to readable plain text.
 */
export function blocksToPlainText(contentJson: string | object): string {
  try {
    // Handle case where content is already parsed (e.g. from JSONB column)
    const blocks = typeof contentJson === "string"
      ? JSON.parse(contentJson)
      : contentJson;
    if (!Array.isArray(blocks)) return String(contentJson);
    return walkBlocks(blocks);
  } catch {
    // If it's already plain text, return as-is
    return String(contentJson);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkBlocks(blocks: any[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      const level = block.props?.level ?? 1;
      lines.push("#".repeat(level) + " " + inlineToText(block.content));
    } else if (block.type === "bulletListItem") {
      lines.push("• " + inlineToText(block.content));
    } else if (block.type === "numberedListItem") {
      lines.push("- " + inlineToText(block.content));
    } else if (block.type === "paragraph") {
      const text = inlineToText(block.content);
      if (text) lines.push(text);
    } else if (block.type === "database") {
      lines.push("[Database table]");
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      lines.push(walkBlocks(block.children));
    }
  }

  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inlineToText(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text ?? "";
      if (c.type === "pageLink") return c.props?.docTitle ?? "link";
      return "";
    })
    .join("");
}
