/**
 * Markdown → BlockNote block JSON.
 *
 * Lifted out of `src/lib/ai/tools.ts`, where it was a private helper for the
 * `create_note` tool. It is shared now because the trac3 iOS app posts markdown
 * to /api/mobile/quick-note and the conversion has to happen somewhere — and
 * reimplementing it in Swift would mean two converters drifting apart against a
 * schema neither of them owns.
 *
 * Handles headings, paragraphs, bullet/numbered/check lists, code blocks, and
 * inline bold / italic / code / strikethrough / links. It does NOT emit Cortex's
 * custom `database` or `pageLink` nodes — those are built explicitly where they
 * are needed.
 */

// ─── Markdown → BlockNote converter ───

/**
 * Convert markdown text to BlockNote JSON blocks.
 * Handles headings, paragraphs, bullet/numbered/check lists, code blocks,
 * and inline formatting (bold, italic, code, strikethrough, links).
 */
export function markdownToBlockNote(md: string): Record<string, unknown>[] {
  const lines = md.split("\n");
  const blocks: Record<string, unknown>[] = [];
  let i = 0;
  let blockIdCounter = 0;

  function nextId(): string {
    return `ai-${Date.now()}-${blockIdCounter++}`;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        id: nextId(),
        type: "codeBlock",
        props: { language: lang || "text" },
        content: [{ type: "text", text: codeLines.join("\n"), styles: {} }],
        children: [],
      });
      continue;
    }

    // Blank line → skip (spacing handled by blocks themselves)
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        id: nextId(),
        type: "heading",
        props: {
          level: headingMatch[1].length,
          textColor: "default",
          backgroundColor: "default",
          textAlignment: "left",
        },
        content: parseInline(headingMatch[2]),
        children: [],
      });
      i++;
      continue;
    }

    // Checklist item: - [ ] or - [x]
    const checkMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (checkMatch) {
      blocks.push({
        id: nextId(),
        type: "checkListItem",
        props: {
          textColor: "default",
          backgroundColor: "default",
          textAlignment: "left",
          checked: checkMatch[1].toLowerCase() === "x",
        },
        content: parseInline(checkMatch[2]),
        children: [],
      });
      i++;
      continue;
    }

    // Bullet list item: - item or * item
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      blocks.push({
        id: nextId(),
        type: "bulletListItem",
        props: {
          textColor: "default",
          backgroundColor: "default",
          textAlignment: "left",
        },
        content: parseInline(bulletMatch[1]),
        children: [],
      });
      i++;
      continue;
    }

    // Numbered list item: 1. item
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      blocks.push({
        id: nextId(),
        type: "numberedListItem",
        props: {
          textColor: "default",
          backgroundColor: "default",
          textAlignment: "left",
        },
        content: parseInline(numberedMatch[1]),
        children: [],
      });
      i++;
      continue;
    }

    // Paragraph (default)
    blocks.push({
      id: nextId(),
      type: "paragraph",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: parseInline(line),
      children: [],
    });
    i++;
  }

  return blocks;
}

/**
 * Parse a single line of markdown inline formatting into BlockNote inline
 * content nodes. Handles bold, italic, inline code, strikethrough, and links.
 */
function parseInline(text: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  // Regex that matches inline formatting tokens in priority order:
  // 1. Links: [text](url)
  // 2. Inline code: `code`
  // 3. Bold+italic: ***text*** or ___text___
  // 4. Bold: **text** or __text__
  // 5. Italic: *text* or _text_  (not preceded/followed by space for _ variant)
  // 6. Strikethrough: ~~text~~
  const inlinePattern =
    /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(text)) !== null) {
    // Push plain text before this match
    if (match.index > lastIndex) {
      nodes.push({
        type: "text",
        text: text.slice(lastIndex, match.index),
        styles: {},
      });
    }

    if (match[1] !== undefined && match[2] !== undefined) {
      // Link: [text](url)
      nodes.push({
        type: "link",
        href: match[2],
        content: [{ type: "text", text: match[1], styles: {} }],
      });
    } else if (match[3] !== undefined) {
      // Inline code
      nodes.push({ type: "text", text: match[3], styles: { code: true } });
    } else if (match[4] !== undefined) {
      // Bold+italic
      nodes.push({
        type: "text",
        text: match[4],
        styles: { bold: true, italic: true },
      });
    } else if (match[5] !== undefined) {
      // Bold
      nodes.push({ type: "text", text: match[5], styles: { bold: true } });
    } else if (match[6] !== undefined) {
      // Italic
      nodes.push({ type: "text", text: match[6], styles: { italic: true } });
    } else if (match[7] !== undefined) {
      // Strikethrough
      nodes.push({
        type: "text",
        text: match[7],
        styles: { strikethrough: true },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex), styles: {} });
  }

  // If nothing was parsed, return at least one empty text node
  if (nodes.length === 0) {
    nodes.push({ type: "text", text, styles: {} });
  }

  return nodes;
}
