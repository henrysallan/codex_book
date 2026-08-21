import { parseFrontmatter, metaString, metaStringArray } from "../frontmatter";
import { ImportFile, ParsedDoc } from "../types";
import { preprocessNotionMarkdown } from "./notion";

export function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function titleFromFilename(filename: string): string {
  const basename = filename.split("/").pop() || filename;
  let name = basename.replace(/\.(md|markdown|txt|csv)$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as-is */
  }
  name = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "Untitled";
}

export function extractLeadingH1(
  body: string
): { text: string; rest: string } | null {
  const match = body.match(/^\s*#\s+(.+?)\s*(?:\n|$)/);
  if (!match) return null;
  return { text: match[1].trim(), rest: body.slice(match[0].length) };
}

export function parseGenericDoc(file: ImportFile): ParsedDoc {
  const { meta, body: afterFm } = parseFrontmatter(file.text);
  let body = preprocessNotionMarkdown(afterFm);

  const fmTitle = metaString(meta.title);
  const h1 = extractLeadingH1(body);
  const filenameTitle = titleFromFilename(file.path);

  let title: string;
  if (fmTitle) {
    title = fmTitle;
  } else if (h1) {
    title = h1.text;
    body = h1.rest;
  } else {
    title = filenameTitle;
  }

  const folderFromMeta = metaString(meta.folder);
  const folderPath = (folderFromMeta ?? dirname(file.path)).replace(/\\/g, "/");

  return {
    path: file.path,
    title,
    subtitle: metaString(meta.subtitle),
    tags: metaStringArray(meta.tags),
    parentTitle: metaString(meta.parent),
    folderPath,
    aliases: metaStringArray(meta.aliases),
    body,
  };
}
