#!/usr/bin/env node
/**
 * One-time Markdown normalizer (Layer B of the import spec).
 *
 * Writes a copy — never in-place.
 *   node scripts/normalize-md.mjs <input-dir> <output-dir>
 *
 * Rewrites:
 *   [Text](Some%20Page.md)  →  [[Some Page]]
 *   First # H1              →  frontmatter title: (H1 stripped from body)
 *
 * Reports only (never auto-rewrites):
 *   @Page Name
 *   [Text](#anchor)
 *   **Bold Title Case**  (possible bold-as-link)
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node scripts/normalize-md.mjs <input-dir> <output-dir>");
  process.exit(1);
}

const inputDir = path.resolve(args[0]);
const outputDir = path.resolve(args[1]);

if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  console.error(`Input is not a directory: ${inputDir}`);
  process.exit(1);
}

if (path.resolve(inputDir) === path.resolve(outputDir)) {
  console.error("Refusing to write in-place. Choose a different output directory.");
  process.exit(1);
}

/** @type {{ file: string; kind: string; detail: string }[]} */
const warnings = [];
let rewrittenLinks = 0;
let addedFrontmatter = 0;
let filesWritten = 0;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function cleanTitleFromFilename(filename) {
  let name = filename.replace(/\.(md|markdown|csv)$/i, "");
  name = name.replace(/ [a-f0-9]{32}$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep */
  }
  return name.trim() || "Untitled";
}

function rewriteRelativeLinks(markdown, fileLabel) {
  return markdown.replace(
    /\[([^\]]+)\]\(([^)]+\.(md|markdown|csv))\)/gi,
    (match, text, url) => {
      if (url.startsWith("http://") || url.startsWith("https://")) return match;
      try {
        const decoded = decodeURIComponent(url);
        const filename = decoded.split("/").pop() || decoded;
        const title = cleanTitleFromFilename(filename);
        rewrittenLinks++;
        return `[[${title}]]`;
      } catch {
        warnings.push({
          file: fileLabel,
          kind: "link-decode",
          detail: match,
        });
        return `[[${text}]]`;
      }
    }
  );
}

function hasFrontmatter(text) {
  return /^---\r?\n/.test(text.replace(/^\uFEFF/, ""));
}

function deriveFrontmatterFromH1(markdown, fileLabel) {
  if (hasFrontmatter(markdown)) return markdown;
  const match = markdown.match(/^\s*#\s+(.+?)\s*(?:\n|$)/);
  if (!match) return markdown;
  const title = match[1].trim();
  const body = markdown.slice(match[0].length);
  addedFrontmatter++;
  warnings.push({
    file: fileLabel,
    kind: "frontmatter-from-h1",
    detail: title,
  });
  return `---\ntitle: ${yamlQuote(title)}\n---\n${body}`;
}

function yamlQuote(value) {
  if (/[:#\-\[\]{}&*!|>'"%@`]/.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}

function reportSuspicious(markdown, fileLabel) {
  const atMentions = markdown.match(/@[A-Za-z][A-Za-z0-9 _-]{1,80}/g) || [];
  for (const m of atMentions) {
    warnings.push({ file: fileLabel, kind: "@mention", detail: m.trim() });
  }

  const anchors = markdown.match(/\[[^\]]+\]\(#(?:[^)]+)\)/g) || [];
  for (const m of anchors) {
    warnings.push({ file: fileLabel, kind: "anchor-link", detail: m });
  }

  const bolds = markdown.match(/\*\*([A-Z][^*]{2,80})\*\*/g) || [];
  for (const m of bolds) {
    warnings.push({ file: fileLabel, kind: "bold-as-link", detail: m });
  }
}

const files = walk(inputDir);
for (const full of files) {
  const rel = path.relative(inputDir, full);
  const dest = path.join(outputDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (!/\.(md|markdown)$/i.test(full)) {
    fs.copyFileSync(full, dest);
    continue;
  }

  let text = fs.readFileSync(full, "utf8");
  reportSuspicious(text, rel);
  text = rewriteRelativeLinks(text, rel);
  text = deriveFrontmatterFromH1(text, rel);
  fs.writeFileSync(dest, text, "utf8");
  filesWritten++;
}

console.log(`Wrote ${filesWritten} markdown file(s) to ${outputDir}`);
console.log(`Rewrote ${rewrittenLinks} relative link(s) to wikilinks`);
console.log(`Derived frontmatter from H1 on ${addedFrontmatter} file(s)`);

const reportKinds = ["@mention", "anchor-link", "bold-as-link", "link-decode"];
const reported = warnings.filter((w) => reportKinds.includes(w.kind));
if (reported.length > 0) {
  console.log(`\n${reported.length} item(s) reported (not rewritten):`);
  const byKind = new Map();
  for (const w of reported) {
    if (!byKind.has(w.kind)) byKind.set(w.kind, []);
    byKind.get(w.kind).push(w);
  }
  for (const [kind, items] of byKind) {
    console.log(`\n  ${kind} (${items.length})`);
    for (const item of items.slice(0, 40)) {
      console.log(`    ${item.file}: ${item.detail}`);
    }
    if (items.length > 40) console.log(`    … +${items.length - 40} more`);
  }
}
