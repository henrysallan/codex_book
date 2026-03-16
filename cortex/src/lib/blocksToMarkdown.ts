/**
 * Convert BlockNote JSON blocks into rich Markdown.
 * Preserves bold, italic, links, code, strikethrough, headings, lists, etc.
 * Used by the share page to render beautiful read-only notes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

export function blocksToMarkdown(contentJson: string | object): string {
  try {
    const blocks =
      typeof contentJson === "string" ? JSON.parse(contentJson) : contentJson;
    if (!Array.isArray(blocks)) return String(contentJson);
    return renderBlocks(blocks, 0).join("\n\n");
  } catch {
    return String(contentJson);
  }
}

function renderBlocks(blocks: Block[], depth: number): string[] {
  const output: string[] = [];
  let numberedIndex = 1;

  for (const block of blocks) {
    const indent = "  ".repeat(depth);
    const line = renderBlock(block, indent, numberedIndex);

    if (line !== null) {
      output.push(line);
    }

    // Track numbered list continuity
    if (block.type === "numberedListItem") {
      numberedIndex++;
    } else {
      numberedIndex = 1;
    }

    // Nested children (indented sub-items)
    if (Array.isArray(block.children) && block.children.length > 0) {
      const childLines = renderBlocks(block.children, depth + 1);
      output.push(...childLines);
    }
  }

  return output;
}

function renderBlock(
  block: Block,
  indent: string,
  numberedIndex: number
): string | null {
  switch (block.type) {
    case "heading": {
      const level = block.props?.level ?? 1;
      const prefix = "#".repeat(Math.min(level, 6));
      return `${prefix} ${inlineToMarkdown(block.content)}`;
    }

    case "paragraph": {
      const text = inlineToMarkdown(block.content);
      return text; // empty paragraphs become empty strings (spacing)
    }

    case "bulletListItem":
      return `${indent}- ${inlineToMarkdown(block.content)}`;

    case "numberedListItem":
      return `${indent}${numberedIndex}. ${inlineToMarkdown(block.content)}`;

    case "checkListItem": {
      const checked = block.props?.checked ? "x" : " ";
      return `${indent}- [${checked}] ${inlineToMarkdown(block.content)}`;
    }

    case "codeBlock": {
      const lang = block.props?.language ?? "";
      const code =
        typeof block.content === "string"
          ? block.content
          : inlineToPlain(block.content);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "image": {
      const url = block.props?.url ?? "";
      const caption = block.props?.caption ?? "";
      return `![${caption}](${url})`;
    }

    case "table": {
      return renderTable(block);
    }

    case "database":
      return `*[Database table]*`;

    default: {
      // Fallback: try to extract any inline text
      const fallback = inlineToMarkdown(block.content);
      return fallback || null;
    }
  }
}

function renderTable(block: Block): string {
  const rows = block.content?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return "";

  const mdRows: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells ?? [];
    const cellTexts = cells.map((cell: Block[]) =>
      Array.isArray(cell) ? inlineToMarkdown(cell) : ""
    );
    mdRows.push(`| ${cellTexts.join(" | ")} |`);

    // Header separator after first row
    if (i === 0) {
      mdRows.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
    }
  }

  return mdRows.join("\n");
}

/**
 * Convert inline content array to markdown with formatting preserved.
 * Handles bold, italic, strikethrough, code, underline, links, and pageLinks.
 */
function inlineToMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((c) => {
      if (typeof c === "string") return c;

      if (c.type === "text") {
        let text: string = c.text ?? "";
        const styles = c.styles ?? {};

        // Apply formatting (order matters: innermost first)
        if (styles.code) text = `\`${text}\``;
        if (styles.bold) text = `**${text}**`;
        if (styles.italic) text = `*${text}*`;
        if (styles.strikethrough) text = `~~${text}~~`;
        if (styles.underline) text = `<u>${text}</u>`;

        return text;
      }

      if (c.type === "link") {
        const href = c.href ?? "";
        const linkText = inlineToMarkdown(c.content);
        return `[${linkText}](${href})`;
      }

      if (c.type === "pageLink") {
        const title = c.props?.docTitle ?? "link";
        const docId = c.props?.docId ?? "";
        // Render as a special link that the share page can intercept
        return `[↗ ${title}](cortex-page:${docId})`;
      }

      return "";
    })
    .join("");
}

/** Plain text extraction for code blocks, etc. */
function inlineToPlain(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text ?? "";
      return "";
    })
    .join("");
}
