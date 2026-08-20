# Markdown Import — Implementation Spec

## Overview

A general-purpose Markdown importer for Cortex. Takes a folder (or zip) of `.md`
files with YAML frontmatter and `[[wikilinks]]`, and produces documents, folders,
sub-page nesting, `pageLink` inline nodes, and backlink rows.

The existing Notion importer becomes one **dialect** of this importer rather than
a separate code path.

**Primary use case:** bulk-importing LLM-generated notes that were written outside
the app with wikilinks already in them. Secondary: Notion exports.

---

## Current State

| Thing | Status |
|---|---|
| `src/components/NotionImport.tsx` | 870 lines, fully implemented, **never mounted** — no import statement anywhere in `src/`. Dead code. |
| Link syntax | `[[Exact Title]]` → resolved to `pageLink` inline node by exact (lowercased, trimmed) title match |
| Title source | Filename only (`cleanNotionName`) — no frontmatter, no H1 |
| Markdown parser | BlockNote's `editor.tryParseMarkdownToBlocks()` |
| Link resolution | Two-pass: create all docs → build `titleToDocId` → walk JSON, swap wikilinks |
| Unmatched links | Silently left as literal `[[text]]`. No report. |
| `parseBacklinks()` (`db.ts:991`) | Already scans raw `[[Title]]` text on **every save** and creates backlink rows |

That last row matters: content imported with correct titles but unconverted syntax
still builds a correct backlink graph. Pill conversion is a rendering upgrade, not a
correctness requirement.

---

## The Authoring Contract

This is the interface. It is what gets pasted into LLM generation prompts, and it is
what the importer must accept.

````markdown
---
title: The Exact Page Title
subtitle: optional one-liner
tags: [ethics, epistemics]
parent: Some Other Page Title   # optional — nests this page under that one
aliases: [Other Name, ONM]      # optional — extra keys this page resolves under
---

Body markdown here, linking to [[Another Page Title]] and
[[Another Page Title|some phrasing that fits the sentence]].

## Related
- [[Another Page Title]]
````

Rules the generator must follow:

- `title` is the page's identity and **must be globally unique**. Duplicate titles
  collide in the resolver index — last one wins.
- Link targets are copied character-for-character from the target's `title:`.
- Only link to pages in the same batch, or known to already exist.
- No `[text](other-page.md)`, no `[text](#anchor)`, no `@Page Name`.
- Filenames are kebab-case of the title; directories become folders.
- The `## Related` trailer is optional but recommended — it gives the validator a
  declared intent to diff against actual resolution.

**Title precedence:** frontmatter `title:` → first `# H1` (stripped from body) →
cleaned filename.

---

## Architecture

```
src/lib/import/
  types.ts          # ImportFile, ImportOptions, ImportReport, ParsedDoc
  frontmatter.ts    # minimal YAML subset → ParsedDoc metadata
  resolve.ts        # normalizeKey, TitleIndex, wikilink splitting, JSON walk
  runImport.ts      # pure orchestration — no React, no DOM
  dialects/
    generic.ts      # frontmatter → H1 → filename
    notion.ts       # hash stripping + relative-link rewrite, then delegates
src/components/ImportDialog.tsx   # single dialog, source picker, report view
```

`runImport` must be **pure of React** so it can be driven from the dialog, from a
drag-drop handler, or from a Node script for bulk loads.

### Data flow

```
Files (path + text)
  → dialect pre-pass (normalize filenames, rewrite legacy link syntax)
  → parse frontmatter + body
  → resolve titles, build TitleIndex (seeded from existing workspace docs)
  → create folders from directory paths
  → create documents (markdown → BlockNote JSON)
  → second pass: setParentDocument() for frontmatter `parent:`
  → third pass: walk JSON, [[X]] → pageLink node, collect unresolved
  → syncBacklinks() per doc
  → AI backfill trigger
  → ImportReport
```

---

## Module Specs

### `types.ts`

```ts
export interface ImportFile { path: string; text: string }

export interface ParsedDoc {
  path: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  parentTitle: string | null;
  folderPath: string;       // derived from path, or frontmatter `folder:`
  aliases: string[];
  body: string;             // markdown with frontmatter + leading H1 removed
}

export interface ImportOptions {
  dialect: "generic" | "notion";
  linkToExisting: boolean;  // seed TitleIndex from workspace docs (default true)
  createStubs: boolean;     // create empty pages for dangling links (default false)
  dryRun: boolean;          // resolve and report, write nothing (default false)
  rootFolderId: string | null;
}

export interface ImportReport {
  foldersCreated: number;
  docsCreated: number;
  databasesCreated: number;
  linksResolved: number;
  stubsCreated: number;
  unresolved: { sourcePath: string; sourceTitle: string; target: string }[];
  duplicateTitles: { title: string; paths: string[] }[];
  errors: string[];
}
```

### `frontmatter.ts`

Deliberately a **minimal YAML subset**, not a dependency. Supports:

- `key: value`
- `key: [a, b, c]`
- `key:` followed by `  - item` lines
- Quoted values, `#` comments outside quotes

Anything else is ignored rather than throwing. Returns `{ meta, body }`; if the file
doesn't open with `---`, returns `{ meta: {}, body: text }` unchanged.

### `resolve.ts`

The core of the migration story. Two exports do most of the work.

```ts
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
```

`TitleIndex` is a `Map<string, string>` (normalized key → docId), populated from:

1. Existing workspace docs (`_dbDocuments`) when `linkToExisting` is true
2. Every imported doc's title
3. Every imported doc's `aliases`

Collisions on insert get recorded into `report.duplicateTitles`; first write wins so
existing workspace docs take precedence over new ones.

`resolveWikilinks(blocks, index)` is lifted almost verbatim from
`NotionImport.tsx:191`, with three changes:

- Uses `WIKILINK` (pipe support) — display text becomes `docTitle`, target resolves `docId`
- Uses `normalizeKey` for lookup instead of `toLowerCase().trim()`
- Returns `unresolved: string[]` alongside `resolved` and `targetDocIds`

### `runImport.ts`

`async function runImport(files: ImportFile[], opts: ImportOptions, onProgress): Promise<ImportReport>`

Phases match the existing Notion flow (`cataloging → folders → documents → databases
→ links → done`), with these additions:

- **Parent pass** between documents and links: for each `ParsedDoc` with a
  `parentTitle`, look it up in the index and call `setParentDocument(docId, parentId)`
  (`db.ts:411` — already exists, no db.ts change needed).
- **Stub pass**: if `createStubs`, create an empty doc for each unresolved target
  before the link pass, and add it to the index.
- **Dry-run**: skip every write, still produce a full `ImportReport`. This is what
  drives the fix-the-content loop.

### `dialects/notion.ts`

Everything Notion-specific, and nothing else:

- `cleanNotionName` — strips the 32-hex hash suffix
- `preprocessNotionMarkdown` — rewrites `[Text](Some%20Page.md)` → `[[Some Page]]`
- Sibling-dir nesting (`Ethics abc123.md` + `Ethics abc123/` → children nest under the `.md`)
- CSV → database block (unchanged from `NotionImport.tsx:511–592`)

### `dialects/generic.ts`

- Title precedence chain (frontmatter → H1 → filename)
- Strips the leading H1 from the body when it was used as the title
- **Also runs `preprocessNotionMarkdown`** — relative `.md` link rewriting is useful
  for any hand-written or LLM-written corpus, not just Notion

---

## Changes to Existing Files

| File | Change |
|---|---|
| `src/components/NotionImport.tsx` | Delete. Logic moves to `src/lib/import/`. |
| `src/components/ImportDialog.tsx` | New. Source picker, progress, report view. |
| `src/components/Sidebar.tsx` | **Mount the dialog.** Add an "Import" action near the create-document buttons (~line 614). |
| `src/lib/db.ts` | No changes required. `setParentDocument` and `syncBacklinks` already cover the needs. |

---

## Migrating Existing Content

Two layers, in this order — the resolver work eliminates most of the file rewriting.

**Layer A — forgiving resolution (no file edits).** `normalizeKey` alone makes
`[[some-page]]`, `[[Some Page]]`, `[[some_page.md]]` and `[[Some  Page]]` all resolve
to the same doc. Alias indexing covers the rest. This is ~30 lines and handles the
majority of the existing corpus.

**Layer B — one-time normalizer script.** A Node script (`scripts/normalize-md.mjs`),
writing to a copy, never in-place:

- `[Text](Some%20Page.md)` → `[[Some Page]]`
- Derive frontmatter from the first `# H1`, then strip that H1 from the body
- **Report only, never auto-rewrite:** `@Page Name`, bold-as-link, `[Text](#anchor)`.
  False-positive rate on these is too high to automate.

**Then close the loop.** Run the importer in `dryRun` mode, take
`report.unresolved`, and hand it back to the LLM: *"these 40 link targets don't
exist — either fix the title or write the missing page."* Iterate to near-zero, then
import for real. The dangling-link report exists specifically to make this loop
possible; without it, quality decays silently across hundreds of pages.

---

## Implementation Steps

Ordered. Each step should leave the app building.

### Phase 1 — Extract and mount

1. **`src/lib/import/types.ts`** — the interfaces above.
2. **`src/lib/import/resolve.ts`** — `normalizeKey`, `WIKILINK`, `TitleIndex`,
   `resolveWikilinks` (lifted from `NotionImport.tsx:162–243`, with pipe + normalized
   lookup + `unresolved` return).
3. **`src/lib/import/runImport.ts`** — move the body of `handleImport`
   (`NotionImport.tsx:312–654`) out of React. Takes `ImportFile[]`, returns
   `ImportReport`. Still Notion-only behaviour at this point.
4. **`src/components/ImportDialog.tsx`** — thin wrapper: file picker → `ImportFile[]`
   → `runImport` → progress + report.
5. **Mount it in `Sidebar.tsx`.** Delete `NotionImport.tsx`.

> 🧪 **Checkpoint:** A Notion export folder imports exactly as before, but through a
> dialog that is actually reachable from the UI.

### Phase 2 — Generic dialect

6. **`src/lib/import/frontmatter.ts`** — the minimal YAML subset parser.
7. **`src/lib/import/dialects/generic.ts`** — title precedence, H1 stripping,
   relative-link rewrite.
8. **Wire `tags` and `subtitle`** from frontmatter into `createDocument`.
9. **Parent pass** — `setParentDocument` for frontmatter `parent:`.
10. **Dialect switch** in the dialog: "Notion export" vs "Markdown folder".

> 🧪 **Checkpoint:** A folder of frontmattered `.md` files imports with correct
> titles, tags, folders, and nesting.

### Phase 3 — Resolution quality

11. **Seed `TitleIndex` from `_dbDocuments`** when `linkToExisting` is true. Highest
    single-value change for incremental batch imports.
12. **Unresolved-link report** — collect during the link pass, render in the dialog
    as a grouped, copyable list.
13. **`dryRun` mode** — checkbox in the dialog; runs every phase, writes nothing.
14. **`createStubs`** — checkbox; empty pages for dangling targets.

> 🧪 **Checkpoint:** Import a batch with three deliberately broken links. Dry run
> reports exactly those three. Stub mode creates exactly three empty pages.

### Phase 4 — Content migration

15. **`scripts/normalize-md.mjs`** — Layer B above, writes to a copy.
16. Dry-run the real corpus, fix, re-run, import.

---

## Out of Scope

- Live `[[wikilink]]` → `pageLink` upgrade in the editor on save. Same resolver would
  apply, but it's a separate change with its own UX questions (what happens when the
  user is mid-typing `[[`).
- Zip upload. Folder picker only for now (`webkitdirectory`).
- Re-import / merge into existing docs by title. Every import creates new documents.
- Image and attachment import.
