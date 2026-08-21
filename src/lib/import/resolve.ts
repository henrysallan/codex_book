import { ImportReport } from "./types";

/** Forgiving key: makes [[some-page]], [[Some Page]], [[some_page.md]] all match. */
export function normalizeKey(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\.(md|markdown|txt|csv)$/, "")
    .replace(/[‘’]/g, "'")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pipe-aware wikilink regex. */
export const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function collectWikilinks(
  markdown: string
): { target: string; display: string; raw: string }[] {
  const results: { target: string; display: string; raw: string }[] = [];
  const re = new RegExp(WIKILINK.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const target = match[1].trim();
    const display = (match[2] ?? match[1]).trim();
    results.push({ target, display, raw: match[0] });
  }
  return results;
}

export class TitleIndex {
  private byKey = new Map<string, string>();
  private pathsByKey = new Map<string, string[]>();
  private titleByKey = new Map<string, string>();
  readonly duplicateTitles: ImportReport["duplicateTitles"] = [];

  seed(docs: { id: string; title: string }[]): void {
    for (const doc of docs) {
      this.insert(doc.title, doc.id, "(existing)");
    }
  }

  /** First write wins. Returns false on collision. */
  insert(title: string, docId: string, path: string): boolean {
    const key = normalizeKey(title);
    if (!key) return false;

    const paths = this.pathsByKey.get(key) ?? [];
    paths.push(path);
    this.pathsByKey.set(key, paths);

    if (this.byKey.has(key)) {
      const existing = this.duplicateTitles.find(
        (d) => normalizeKey(d.title) === key
      );
      if (existing) {
        existing.paths = [...paths];
      } else {
        this.duplicateTitles.push({
          title: this.titleByKey.get(key) ?? title,
          paths: [...paths],
        });
      }
      return false;
    }

    this.byKey.set(key, docId);
    this.titleByKey.set(key, title);
    return true;
  }

  lookup(title: string): string | undefined {
    const key = normalizeKey(title);
    if (!key) return undefined;
    return this.byKey.get(key);
  }

  has(title: string): boolean {
    return this.lookup(title) !== undefined;
  }
}

type WikiPart =
  | { type: "text"; text: string }
  | { type: "pageLink"; docId: string; title: string };

export function splitWikilinks(text: string, index: TitleIndex): WikiPart[] {
  const parts: WikiPart[] = [];
  const re = new RegExp(WIKILINK.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const target = match[1].trim();
    const display = (match[2] ?? match[1]).trim();
    const docId = index.lookup(target);
    if (docId) {
      parts.push({ type: "pageLink", docId, title: display });
    } else {
      parts.push({ type: "text", text: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", text: text.slice(lastIndex) });
  }
  return parts;
}

/**
 * Walk BlockNote JSON and replace [[wikilinks]] in text nodes with pageLink
 * inline content nodes.
 */
export function resolveWikilinks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[],
  index: TitleIndex
): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[];
  resolved: number;
  targetDocIds: string[];
  unresolved: string[];
} {
  let resolved = 0;
  const targetDocIds: string[] = [];
  const unresolved: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processInline(nodes: any[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any[] = [];
    for (const node of nodes) {
      if (
        node.type === "text" &&
        typeof node.text === "string" &&
        node.text.includes("[[")
      ) {
        const parts = splitWikilinks(node.text, index);
        for (const part of parts) {
          if (part.type === "pageLink") {
            result.push({
              type: "pageLink",
              props: { docId: part.docId, docTitle: part.title },
            });
            targetDocIds.push(part.docId);
            resolved++;
          } else if (part.text) {
            result.push({ ...node, text: part.text });
            for (const link of collectWikilinks(part.text)) {
              unresolved.push(link.target);
            }
          }
        }
      } else if (node.content && Array.isArray(node.content)) {
        result.push({ ...node, content: processInline(node.content) });
      } else {
        result.push(node);
      }
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processBlocks(blks: any[]): any[] {
    return blks.map((block) => ({
      ...block,
      content: Array.isArray(block.content)
        ? processInline(block.content)
        : block.content,
      children: Array.isArray(block.children)
        ? processBlocks(block.children)
        : block.children,
    }));
  }

  return { blocks: processBlocks(blocks), resolved, targetDocIds, unresolved };
}
