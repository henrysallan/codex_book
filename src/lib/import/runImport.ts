import { BlockNoteEditor } from "@blocknote/core";
import { v4 as uuidv4 } from "uuid";
import {
  createDocument as dbCreateDocument,
  updateDocument as dbUpdateDocument,
  createFolder as dbCreateFolder,
  setParentDocument as dbSetParentDocument,
  syncBacklinks,
} from "@/lib/db";
import { schema } from "@/lib/editorSchema";
import { authedFetch } from "@/lib/apiFetch";
import {
  DEFAULT_IMPORT_OPTIONS,
  emptyImportReport,
  ImportFile,
  ImportOptions,
  ImportProgress,
  ImportReport,
  ParsedDoc,
} from "./types";
import { TitleIndex, collectWikilinks, normalizeKey, resolveWikilinks } from "./resolve";
import { dirname, parseGenericDoc } from "./dialects/generic";
import {
  cleanNotionName,
  csvToDatabaseContent,
  detectSubNoteDirs,
  normalizeNotionPath,
} from "./dialects/notion";

export async function runImport(
  files: ImportFile[],
  opts: ImportOptions,
  onProgress?: (p: ImportProgress) => void,
  existingDocs: { id: string; title: string }[] = []
): Promise<ImportReport> {
  const options: ImportOptions = {
    ...DEFAULT_IMPORT_OPTIONS,
    ...opts,
  };
  const report = emptyImportReport();
  const progress = (phase: ImportProgress["phase"], current = 0, total = 0) =>
    onProgress?.({ phase, current, total });

  try {
    progress("cataloging");

    const prepared = files.map((f) => ({
      ...f,
      path:
        options.dialect === "notion" ? normalizeNotionPath(f.path) : f.path,
    }));

    const mdFiles = prepared.filter((f) => /\.(md|markdown)$/i.test(f.path));
    const csvFiles =
      options.dialect === "notion"
        ? prepared.filter((f) => /\.csv$/i.test(f.path))
        : [];

    const parsedDocs: ParsedDoc[] = [];
    for (const file of mdFiles) {
      try {
        parsedDocs.push(parseGenericDoc(file));
      } catch (err) {
        report.errors.push(`Parse "${file.path}": ${err}`);
      }
    }

    const mdPaths = parsedDocs.map((d) => d.path);
    const subNoteDirs =
      options.dialect === "notion"
        ? detectSubNoteDirs(mdPaths)
        : new Map<string, string>();
    const subNoteDirSet = new Set(subNoteDirs.keys());

    const index = new TitleIndex();
    if (options.linkToExisting) {
      index.seed(existingDocs);
    }

    for (const doc of parsedDocs) {
      const id = uuidv4();
      index.insert(doc.title, id, doc.path);
      for (const alias of doc.aliases) {
        index.insert(alias, id, doc.path);
      }
    }

    const folderPaths = collectFolderPaths(
      parsedDocs,
      csvFiles.map((f) => f.path),
      subNoteDirSet
    );

    if (options.dryRun) {
      return dryRunReport(
        options,
        report,
        parsedDocs,
        csvFiles,
        folderPaths,
        index,
        progress
      );
    }

    // Real IDs replace phantoms as documents are created.
    progress("folders", 0, folderPaths.length);
    const dirToFolderId = new Map<string, string>();
    for (let i = 0; i < folderPaths.length; i++) {
      const dirPath = folderPaths[i];
      const parts = dirPath.split("/");
      const dirName = folderSegmentName(parts[parts.length - 1]);
      const parentPath = parts.slice(0, -1).join("/");
      const parentId = parentPath
        ? dirToFolderId.get(parentPath) ?? options.rootFolderId
        : options.rootFolderId;
      try {
        const folder = await dbCreateFolder(dirName, parentId);
        dirToFolderId.set(dirPath, folder.id);
        report.foldersCreated++;
      } catch (err) {
        report.errors.push(`Folder "${dirName}": ${err}`);
      }
      progress("folders", i + 1, folderPaths.length);
    }

    progress("documents", 0, parsedDocs.length);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tempEditor = BlockNoteEditor.create({ schema } as any);
    const createdDocs = new Map<string, string>();
    const pathToDocId = new Map<string, string>();

    const sortedDocs = [...parsedDocs].sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length
    );

    for (let i = 0; i < sortedDocs.length; i++) {
      const parsed = sortedDocs[i];
      try {
        const blocks = await tempEditor.tryParseMarkdownToBlocks(parsed.body);
        const content = JSON.stringify(blocks);
        const dirPath = dirname(parsed.path);
        let folderId: string | null = options.rootFolderId;
        let parentDocumentId: string | null = null;

        if (dirPath && subNoteDirSet.has(dirPath)) {
          const parentMdPath = subNoteDirs.get(dirPath);
          if (parentMdPath && pathToDocId.has(parentMdPath)) {
            parentDocumentId = pathToDocId.get(parentMdPath)!;
          }
        } else if (parsed.folderPath) {
          folderId =
            dirToFolderId.get(parsed.folderPath) ?? options.rootFolderId;
        }

        const doc = await dbCreateDocument(
          folderId,
          parsed.title,
          content,
          parentDocumentId
        );
        if (parsed.subtitle || parsed.tags.length > 0) {
          await dbUpdateDocument(doc.id, {
            ...(parsed.subtitle ? { subtitle: parsed.subtitle } : {}),
            ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
          });
        }

        pathToDocId.set(parsed.path, doc.id);
        createdDocs.set(doc.id, content);
        report.docsCreated++;
      } catch (err) {
        report.errors.push(`Page "${parsed.title}": ${err}`);
      }
      progress("documents", i + 1, parsedDocs.length);
    }

    // Rebuild index with real IDs so lookups don't point at phantoms.
    const realIndex = new TitleIndex();
    if (options.linkToExisting) realIndex.seed(existingDocs);
    for (const parsed of parsedDocs) {
      const id = pathToDocId.get(parsed.path);
      if (!id) continue;
      realIndex.insert(parsed.title, id, parsed.path);
      for (const alias of parsed.aliases) {
        realIndex.insert(alias, id, parsed.path);
      }
    }
    report.duplicateTitles = realIndex.duplicateTitles;

    progress("databases", 0, csvFiles.length);
    for (let i = 0; i < csvFiles.length; i++) {
      const file = csvFiles[i];
      try {
        const content = csvToDatabaseContent(file.text, realIndex);
        if (!content) continue;
        const dirPath = dirname(file.path);
        const folderId = dirPath
          ? dirToFolderId.get(dirPath) ?? options.rootFolderId
          : options.rootFolderId;
        const title = cleanNotionName(file.path.split("/").pop() || file.path);
        const doc = await dbCreateDocument(folderId, title, content);
        realIndex.insert(title, doc.id, file.path);
        createdDocs.set(doc.id, content);
        report.databasesCreated++;
      } catch (err) {
        report.errors.push(`Database "${file.path}": ${err}`);
      }
      progress("databases", i + 1, csvFiles.length);
    }

    progress("links");

    for (const parsed of parsedDocs) {
      const docId = pathToDocId.get(parsed.path);
      if (!docId || !parsed.parentTitle) continue;
      const parentId = realIndex.lookup(parsed.parentTitle);
      if (!parentId) {
        report.errors.push(
          `Parent "${parsed.parentTitle}" not found for "${parsed.title}"`
        );
        continue;
      }
      if (parentId === docId) continue;
      try {
        await dbSetParentDocument(docId, parentId);
      } catch (err) {
        report.errors.push(`Parent for "${parsed.title}": ${err}`);
      }
    }

    const dangling = collectDangling(parsedDocs, realIndex);
    if (options.createStubs) {
      const uniqueTargets = uniqueByKey(dangling.map((d) => d.target));
      for (const target of uniqueTargets) {
        try {
          const stub = await dbCreateDocument(
            options.rootFolderId,
            target,
            "[]"
          );
          realIndex.insert(target, stub.id, "(stub)");
          createdDocs.set(stub.id, "[]");
          report.stubsCreated++;
        } catch (err) {
          report.errors.push(`Stub "${target}": ${err}`);
        }
      }
    }

    report.unresolved = collectDangling(parsedDocs, realIndex);

    const docEntries = [...createdDocs.entries()];
    progress("links", 0, docEntries.length);
    for (let i = 0; i < docEntries.length; i++) {
      const [docId, contentJson] = docEntries[i];
      try {
        let blocks: unknown[];
        try {
          blocks = JSON.parse(contentJson);
        } catch {
          continue;
        }
        if (!Array.isArray(blocks)) continue;

        const {
          blocks: resolved,
          resolved: count,
          targetDocIds,
        } = resolveWikilinks(blocks, realIndex);

        if (count > 0) {
          const newContent = JSON.stringify(resolved);
          await dbUpdateDocument(docId, { content: newContent });
          report.linksResolved += count;
          const uniqueTargets = [...new Set(targetDocIds)];
          await syncBacklinks(docId, uniqueTargets);
        }
      } catch (err) {
        report.errors.push(`Link resolution: ${err}`);
      }
      progress("links", i + 1, docEntries.length);
    }

    const importedDocIds = [...createdDocs.keys()];
    if (importedDocIds.length > 0) {
      authedFetch("/api/ai/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: importedDocIds }),
      }).catch((err) =>
        console.error("[import] backfill trigger failed:", err)
      );
    }

    progress("done", 1, 1);
    return report;
  } catch (err) {
    report.errors.push(`Fatal: ${err}`);
    progress("done", 1, 1);
    return report;
  }
}

function dryRunReport(
  options: ImportOptions,
  report: ImportReport,
  parsedDocs: ParsedDoc[],
  csvFiles: ImportFile[],
  folderPaths: string[],
  index: TitleIndex,
  progress: (phase: ImportProgress["phase"], current?: number, total?: number) => void
): ImportReport {
  progress("folders", folderPaths.length, folderPaths.length);
  report.foldersCreated = folderPaths.length;
  progress("documents", parsedDocs.length, parsedDocs.length);
  report.docsCreated = parsedDocs.length;
  progress("databases", csvFiles.length, csvFiles.length);
  report.databasesCreated = csvFiles.length;
  report.duplicateTitles = index.duplicateTitles;
  progress("links");

  const dangling = collectDangling(parsedDocs, index);
  if (options.createStubs) {
    const uniqueTargets = uniqueByKey(dangling.map((d) => d.target));
    report.stubsCreated = uniqueTargets.length;
    for (const target of uniqueTargets) {
      index.insert(target, uuidv4(), "(stub)");
    }
    report.unresolved = [];
  } else {
    report.unresolved = dangling;
  }

  for (const doc of parsedDocs) {
    for (const link of collectWikilinks(doc.body)) {
      if (index.lookup(link.target)) report.linksResolved++;
    }
  }

  progress("done", 1, 1);
  return report;
}

function collectDangling(
  docs: ParsedDoc[],
  index: TitleIndex
): ImportReport["unresolved"] {
  const unresolved: ImportReport["unresolved"] = [];
  for (const doc of docs) {
    for (const link of collectWikilinks(doc.body)) {
      if (!index.lookup(link.target)) {
        unresolved.push({
          sourcePath: doc.path,
          sourceTitle: doc.title,
          target: link.target,
        });
      }
    }
  }
  return unresolved;
}

function uniqueByKey(targets: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of targets) {
    const key = normalizeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result;
}

function collectFolderPaths(
  docs: ParsedDoc[],
  csvPaths: string[],
  subNoteDirs: Set<string>
): string[] {
  const dirs = new Set<string>();
  const addTree = (folderPath: string) => {
    if (!folderPath) return;
    const parts = folderPath.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!subNoteDirs.has(acc)) dirs.add(acc);
    }
  };
  for (const doc of docs) {
    const fsDir = dirname(doc.path);
    if (fsDir && subNoteDirs.has(fsDir)) continue;
    addTree(doc.folderPath);
  }
  for (const csvPath of csvPaths) {
    const dir = dirname(csvPath);
    if (dir && subNoteDirs.has(dir)) continue;
    addTree(dir);
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length);
}

function folderSegmentName(segment: string): string {
  let name = segment;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep */
  }
  return name.trim() || "Untitled";
}
