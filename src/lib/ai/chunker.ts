/**
 * Chunker — splits BlockNote document JSON into semantic chunks.
 *
 * Follows document structure: headings create chunk boundaries, lists
 * stay together, and long sections split at paragraph boundaries.
 *
 * Target: 300–500 tokens per chunk (~230–385 words).
 */

// ─── Types ───

export interface Chunk {
  content: string;
  heading: string | null;
  blockIds: string[];
  tokenCount: number;
}

// Approximate token count. Word×1.3 undercounts code, CJK, and URLs;
// take the max of that and chars/4 so a pasted wall of text can't slip
// past the embedding input limit.
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const wordEst = Math.ceil(words * 1.3);
  const charEst = Math.ceil(text.length / 4);
  return Math.max(wordEst, charEst);
}

function packPieces(
  pieces: string[],
  join: string,
  maxTokens: number,
  nextStage: SplitStage
): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let tokens = 0;
  const flush = () => {
    if (buf.length === 0) return;
    const joined = buf.join(join);
    buf = [];
    tokens = 0;
    if (estimateTokens(joined) > maxTokens) {
      out.push(...splitToTokenLimit(joined, maxTokens, nextStage));
    } else {
      out.push(joined);
    }
  };
  for (const piece of pieces) {
    const t = estimateTokens(piece);
    if (t > maxTokens) {
      flush();
      out.push(...splitToTokenLimit(piece, maxTokens, nextStage));
      continue;
    }
    if (tokens + t > maxTokens && buf.length > 0) flush();
    buf.push(piece);
    tokens += t;
  }
  flush();
  return out;
}

type SplitStage = "paragraph" | "line" | "sentence" | "char";

/** Split text until every piece is within the embedding-safe token budget. */
function splitToTokenLimit(
  text: string,
  maxTokens: number,
  stage: SplitStage = "paragraph"
): string[] {
  if (!text) return [];
  if (estimateTokens(text) <= maxTokens) return [text];

  if (stage === "paragraph") {
    const paragraphs = text.split(/\n\n+/);
    if (paragraphs.length > 1) return packPieces(paragraphs, "\n\n", maxTokens, "line");
    return splitToTokenLimit(text, maxTokens, "line");
  }
  if (stage === "line") {
    const lines = text.split("\n");
    if (lines.length > 1) return packPieces(lines, "\n", maxTokens, "sentence");
    return splitToTokenLimit(text, maxTokens, "sentence");
  }
  if (stage === "sentence") {
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) return packPieces(sentences, " ", maxTokens, "char");
    return splitToTokenLimit(text, maxTokens, "char");
  }

  const maxChars = Math.max(1, maxTokens * 4);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

function chunksFromOversizedBlock(
  text: string,
  heading: string | null,
  blockIds: string[]
): Chunk[] {
  const parts = splitToTokenLimit(text.trim(), MAX_TOKENS);
  return parts
    .filter((p) => p.trim())
    .map((content, i) => ({
      content: content.trim(),
      heading,
      blockIds: i === 0 ? blockIds : [],
      tokenCount: estimateTokens(content),
    }));
}

// ─── Block text extraction ───

interface BlockNode {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: InlineContent[];
  children?: BlockNode[];
}

type InlineContent =
  | { type: "text"; text: string; styles?: Record<string, unknown> }
  | { type: "pageLink"; props?: { docId?: string; docTitle?: string } }
  | { type: string; [key: string]: unknown };

/** Extract plain text from a block's inline content array. */
function inlineContentToText(content: InlineContent[] | undefined): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "pageLink") {
        const props = item.props as Record<string, unknown> | undefined;
        return (props?.docTitle as string) ?? "[[link]]";
      }
      return "";
    })
    .join("");
}

/** Extract all text from a block and its children recursively. */
function blockToText(block: BlockNode): string {
  const parts: string[] = [];

  const own = inlineContentToText(block.content);
  if (own) parts.push(own);

  // Special handling for database blocks — extract a brief description
  if (block.type === "database" && block.props?.data) {
    const data = block.props.data as { columns?: { name: string }[]; rows?: unknown[] };
    const colNames = (data.columns ?? []).map((c) => c.name).join(", ");
    const rowCount = (data.rows ?? []).length;
    parts.push(`[Database table: columns: ${colNames}; ${rowCount} rows]`);
  }

  if (block.children && block.children.length > 0) {
    for (const child of block.children) {
      const childText = blockToText(child);
      if (childText) parts.push(childText);
    }
  }

  return parts.join("\n");
}

/** Collect all block IDs from a block and its children. */
function collectBlockIds(block: BlockNode): string[] {
  const ids: string[] = [];
  if (block.id) ids.push(block.id);
  if (block.children) {
    for (const child of block.children) {
      ids.push(...collectBlockIds(child));
    }
  }
  return ids;
}

// ─── Heading detection ───

function isHeading(block: BlockNode): boolean {
  return block.type === "heading";
}

// ─── Chunking constants ───

const MIN_TOKENS = 80;
const TARGET_TOKENS = 400;
const MAX_TOKENS = 600;

// ─── Main chunker ───

interface PendingChunk {
  texts: string[];
  heading: string | null;
  blockIds: string[];
  tokenCount: number;
}

function emptyPending(heading: string | null): PendingChunk {
  return { texts: [], heading, blockIds: [], tokenCount: 0 };
}

function flushPending(pending: PendingChunk, result: Chunk[]): void {
  if (pending.texts.length === 0) return;
  const content = pending.texts.join("\n\n").trim();
  if (!content) return;
  result.push({
    content,
    heading: pending.heading,
    blockIds: [...pending.blockIds],
    tokenCount: pending.tokenCount,
  });
}

/**
 * Split BlockNote document JSON into semantic chunks.
 *
 * @param contentJson - The raw `content` string from the documents table (JSON array of blocks)
 * @returns Array of chunks ready for summarization and embedding
 */
export function blocksToChunks(contentJson: string): Chunk[] {
  let blocks: BlockNode[];
  try {
    blocks = JSON.parse(contentJson);
    if (!Array.isArray(blocks)) return [];
  } catch {
    return [];
  }

  if (blocks.length === 0) return [];

  const result: Chunk[] = [];
  let currentHeading: string | null = null;
  let pending = emptyPending(null);

  for (const block of blocks) {
    // If it's a heading, flush the current pending chunk and start a new one
    if (isHeading(block)) {
      flushPending(pending, result);
      currentHeading = inlineContentToText(block.content) || null;
      pending = emptyPending(currentHeading);
      // Include the heading text in the chunk
      const headingText = currentHeading;
      if (headingText) {
        pending.texts.push(headingText);
        pending.blockIds.push(...collectBlockIds(block));
        pending.tokenCount += estimateTokens(headingText);
      }
      continue;
    }

    const text = blockToText(block);
    if (!text.trim()) continue;

    const blockTokens = estimateTokens(text);
    const ids = collectBlockIds(block);

    // If adding this block would push us over max, flush first
    if (pending.tokenCount > 0 && pending.tokenCount + blockTokens > MAX_TOKENS) {
      flushPending(pending, result);
      pending = emptyPending(currentHeading);
    }

    // If the block itself is huge, split it so no piece exceeds the embedder.
    if (blockTokens > MAX_TOKENS) {
      flushPending(pending, result);
      result.push(...chunksFromOversizedBlock(text, currentHeading, ids));
      pending = emptyPending(currentHeading);
      continue;
    }

    // Accumulate
    pending.texts.push(text);
    pending.blockIds.push(...ids);
    pending.tokenCount += blockTokens;

    // If we've reached a good target size, flush
    if (pending.tokenCount >= TARGET_TOKENS) {
      flushPending(pending, result);
      pending = emptyPending(currentHeading);
    }
  }

  // Flush remaining
  flushPending(pending, result);

  // Merge tiny trailing chunks into the previous one
  if (result.length > 1) {
    const last = result[result.length - 1];
    if (last.tokenCount < MIN_TOKENS) {
      const prev = result[result.length - 2];
      prev.content += "\n\n" + last.content;
      prev.blockIds.push(...last.blockIds);
      prev.tokenCount += last.tokenCount;
      result.pop();
    }
  }

  return result;
}
