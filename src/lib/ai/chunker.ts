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

// Approximate token count: words × 1.3
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
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

function getHeadingLevel(block: BlockNode): number {
  if (block.type === "heading" && block.props && typeof block.props.level === "number") {
    return block.props.level as number;
  }
  return 999; // not a heading
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

    // If the block itself is huge, make it its own chunk
    if (blockTokens > MAX_TOKENS) {
      flushPending(pending, result);
      result.push({
        content: text.trim(),
        heading: currentHeading,
        blockIds: ids,
        tokenCount: blockTokens,
      });
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
