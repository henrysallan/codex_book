"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import {
  X,
  Check,
  Loader2,
  FileText,
  FolderOpen,
  Database,
  Link,
  AlertTriangle,
  Copy,
  CheckCheck,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { runImport } from "@/lib/import/runImport";
import {
  DEFAULT_IMPORT_OPTIONS,
  ImportFile,
  ImportOptions,
  ImportPhase,
  ImportProgress,
  ImportReport,
} from "@/lib/import/types";

const PHASE_LABELS: Record<ImportPhase, string> = {
  cataloging: "Scanning files…",
  folders: "Creating folders…",
  documents: "Importing pages…",
  databases: "Importing databases…",
  links: "Resolving links & backlinks…",
  done: "Complete!",
};

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportDialog({ isOpen, onClose }: ImportDialogProps) {
  const initialize = useAppStore((s) => s.initialize);
  const [dialect, setDialect] = useState<ImportOptions["dialect"]>("generic");
  const [linkToExisting, setLinkToExisting] = useState(
    DEFAULT_IMPORT_OPTIONS.linkToExisting
  );
  const [createStubs, setCreateStubs] = useState(
    DEFAULT_IMPORT_OPTIONS.createStubs
  );
  const [dryRun, setDryRun] = useState(DEFAULT_IMPORT_OPTIONS.dryRun);
  const [files, setFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [copied, setCopied] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const mdFiles = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
  const csvFiles = files.filter((f) => /\.csv$/i.test(f.name));

  const reset = useCallback(() => {
    setFiles([]);
    setReport(null);
    setProgress(null);
    setCopied(false);
  }, []);

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files || []);
    const relevant = all.filter(
      (f) =>
        /\.(md|markdown)$/i.test(f.name) ||
        (dialect === "notion" && /\.csv$/i.test(f.name))
    );
    setFiles(relevant);
    setReport(null);
    setProgress(null);
  };

  const handleImport = useCallback(async () => {
    if (files.length === 0) return;
    setImporting(true);
    setReport(null);

    try {
      const importFiles = await filesToImportFiles(files);
      const existingDocs = linkToExisting
        ? useAppStore.getState()._dbDocuments.map((d) => ({
            id: d.id,
            title: d.title,
          }))
        : [];

      const result = await runImport(
        importFiles,
        {
          dialect,
          linkToExisting,
          createStubs,
          dryRun,
          rootFolderId: null,
        },
        (p) => setProgress(p),
        existingDocs
      );

      setReport(result);
      if (!dryRun) await initialize();
    } catch (err) {
      setReport({
        foldersCreated: 0,
        docsCreated: 0,
        databasesCreated: 0,
        linksResolved: 0,
        stubsCreated: 0,
        unresolved: [],
        duplicateTitles: [],
        errors: [`Fatal: ${err}`],
      });
    } finally {
      setImporting(false);
    }
  }, [
    files,
    dialect,
    linkToExisting,
    createStubs,
    dryRun,
    initialize,
  ]);

  const handleClose = useCallback(() => {
    if (importing) return;
    reset();
    onClose();
  }, [importing, onClose, reset]);

  const unresolvedTargets = useMemo(() => {
    if (!report) return [];
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const u of report.unresolved) {
      const key = u.target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(u.target);
    }
    return targets;
  }, [report]);

  const copyUnresolved = useCallback(async () => {
    if (unresolvedTargets.length === 0) return;
    const text = unresolvedTargets.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [unresolvedTargets]);

  if (!isOpen) return null;

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  const pickerLabel =
    dialect === "notion" ? "Notion export folder" : "Markdown folder";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !importing) handleClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[540px] max-h-[720px] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">
            Import Markdown
          </h2>
          <button
            onClick={handleClose}
            disabled={importing}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {!report && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <DialectButton
                  selected={dialect === "generic"}
                  disabled={importing}
                  title="Markdown folder"
                  subtitle="YAML frontmatter, [[wikilinks]], folders from directories"
                  onClick={() => {
                    setDialect("generic");
                    reset();
                  }}
                />
                <DialectButton
                  selected={dialect === "notion"}
                  disabled={importing}
                  title="Notion export"
                  subtitle="Hash-stripped names, relative .md links, CSV databases"
                  onClick={() => {
                    setDialect("notion");
                    reset();
                  }}
                />
              </div>

              <p className="text-sm text-muted-foreground">
                {dialect === "notion" ? (
                  <>
                    Export your Notion workspace as{" "}
                    <strong>Markdown &amp; CSV</strong>, unzip the archive, then
                    select the exported folder below.
                  </>
                ) : (
                  <>
                    Select a folder of <strong>.md</strong> files. Titles come
                    from frontmatter, then the first H1, then the filename.
                    Directories become folders.
                  </>
                )}
              </p>

              <div
                className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
                onClick={() => folderInputRef.current?.click()}
              >
                <FolderOpen
                  size={24}
                  className="mx-auto mb-2 text-muted-foreground"
                />
                <p className="text-sm text-muted-foreground">
                  Click to select your <strong>{pickerLabel}</strong>
                </p>
                <input
                  ref={folderInputRef}
                  type="file"
                  /* @ts-expect-error webkitdirectory is non-standard but widely supported */
                  webkitdirectory=""
                  directory=""
                  onChange={handleFolderSelect}
                  className="hidden"
                />
              </div>

              {files.length > 0 && !importing && (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-foreground">
                    <FileText size={14} className="text-blue-500" />
                    <span>
                      {mdFiles.length} page{mdFiles.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {dialect === "notion" && csvFiles.length > 0 && (
                    <div className="flex items-center gap-2 text-foreground">
                      <Database size={14} className="text-green-500" />
                      <span>
                        {csvFiles.length} database
                        {csvFiles.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {files.length} total file{files.length !== 1 ? "s" : ""}{" "}
                    detected
                  </p>
                </div>
              )}

              <div className="space-y-2 text-sm border border-border rounded-lg p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    disabled={importing}
                  />
                  <span>Dry run — resolve and report, write nothing</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createStubs}
                    onChange={(e) => setCreateStubs(e.target.checked)}
                    disabled={importing}
                  />
                  <span>Create stub pages for dangling links</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={linkToExisting}
                    onChange={(e) => setLinkToExisting(e.target.checked)}
                    disabled={importing}
                  />
                  <span>Link to existing workspace pages</span>
                </label>
              </div>
            </>
          )}

          {importing && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Loader2 size={14} className="animate-spin text-blue-500" />
                <span>
                  {progress ? PHASE_LABELS[progress.phase] : "Starting…"}
                </span>
              </div>
              {progress && progress.total > 0 && (
                <div className="space-y-1">
                  <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-200"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-right">
                    {progress.current} / {progress.total}
                  </p>
                </div>
              )}
            </div>
          )}

          {report && <ReportView report={report} dryRun={dryRun} />}

          {report && report.unresolved.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-amber-600">
                  <AlertTriangle size={12} />
                  <span>
                    {report.unresolved.length} unresolved link
                    {report.unresolved.length !== 1 ? "s" : ""}
                    {unresolvedTargets.length !== report.unresolved.length
                      ? ` (${unresolvedTargets.length} unique targets)`
                      : ""}
                  </span>
                </div>
                <button
                  onClick={copyUnresolved}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy targets"}
                </button>
              </div>
              <div className="max-h-[160px] overflow-y-auto text-xs bg-gray-50 rounded p-2 space-y-2">
                {groupUnresolved(report.unresolved).map((group) => (
                  <div key={group.target}>
                    <p className="font-medium text-foreground">
                      {group.target}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({group.sources.length})
                      </span>
                    </p>
                    {group.sources.slice(0, 8).map((s, i) => (
                      <p key={i} className="truncate text-muted-foreground pl-2">
                        {s.sourceTitle}
                        {s.sourcePath !== s.sourceTitle
                          ? ` · ${s.sourcePath}`
                          : ""}
                      </p>
                    ))}
                    {group.sources.length > 8 && (
                      <p className="pl-2 text-muted-foreground">
                        +{group.sources.length - 8} more
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {report && report.duplicateTitles.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-amber-600">
                {report.duplicateTitles.length} duplicate title
                {report.duplicateTitles.length !== 1 ? "s" : ""} (first wins)
              </p>
              <div className="max-h-[80px] overflow-y-auto text-xs text-muted-foreground bg-gray-50 rounded p-2 space-y-0.5">
                {report.duplicateTitles.map((d, i) => (
                  <p key={i} className="truncate">
                    {d.title}: {d.paths.join(", ")}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleClose}
            disabled={importing}
            className="px-4 py-2 text-sm text-foreground hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            {report ? "Done" : "Cancel"}
          </button>
          {report && (
            <button
              onClick={reset}
              className="px-4 py-2 text-sm text-foreground hover:bg-gray-100 rounded-lg transition-colors"
            >
              Import another
            </button>
          )}
          {!report && (
            <button
              onClick={handleImport}
              disabled={files.length === 0 || importing}
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-2"
            >
              {importing && <Loader2 size={14} className="animate-spin" />}
              {importing
                ? dryRun
                  ? "Checking…"
                  : "Importing…"
                : dryRun
                  ? `Check ${files.length} file${files.length !== 1 ? "s" : ""}`
                  : `Import ${files.length} file${files.length !== 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DialectButton({
  selected,
  disabled,
  title,
  subtitle,
  onClick,
}: {
  selected: boolean;
  disabled: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-lg border p-3 transition-colors ${
        selected
          ? "border-blue-500 bg-blue-50/60"
          : "border-border hover:border-blue-300"
      } disabled:opacity-50`}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
    </button>
  );
}

function ReportView({
  report,
  dryRun,
}: {
  report: ImportReport;
  dryRun: boolean;
}) {
  const hasIssues =
    report.errors.length > 0 ||
    report.unresolved.length > 0 ||
    report.duplicateTitles.length > 0;

  return (
    <div className="space-y-3">
      <div
        className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
          hasIssues
            ? "bg-yellow-50 text-yellow-700"
            : "bg-green-50 text-green-700"
        }`}
      >
        <Check size={16} />
        <span>{dryRun ? "Dry run complete" : "Import complete"}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="flex items-center gap-2 text-foreground">
          <FolderOpen size={14} className="text-amber-500" />
          <span>
            {report.foldersCreated} folder
            {report.foldersCreated !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-foreground">
          <FileText size={14} className="text-blue-500" />
          <span>
            {report.docsCreated} page{report.docsCreated !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-foreground">
          <Database size={14} className="text-green-500" />
          <span>
            {report.databasesCreated} database
            {report.databasesCreated !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-foreground">
          <Link size={14} className="text-purple-500" />
          <span>
            {report.linksResolved} link
            {report.linksResolved !== 1 ? "s" : ""} resolved
          </span>
        </div>
        {report.stubsCreated > 0 && (
          <div className="flex items-center gap-2 text-foreground col-span-2">
            <FileText size={14} className="text-gray-500" />
            <span>
              {report.stubsCreated} stub
              {report.stubsCreated !== 1 ? "s" : ""} created
            </span>
          </div>
        )}
      </div>

      {report.errors.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle size={12} />
            <span>
              {report.errors.length} warning
              {report.errors.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="max-h-[100px] overflow-y-auto text-xs text-muted-foreground bg-gray-50 rounded p-2 space-y-0.5">
            {report.errors.map((err, i) => (
              <p key={i} className="truncate">
                {err}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function groupUnresolved(items: ImportReport["unresolved"]): {
  target: string;
  sources: ImportReport["unresolved"];
}[] {
  const map = new Map<string, ImportReport["unresolved"]>();
  const order: string[] = [];
  for (const item of items) {
    const key = item.target.toLowerCase();
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(item);
  }
  return order.map((key) => ({
    target: map.get(key)![0].target,
    sources: map.get(key)!,
  }));
}

async function filesToImportFiles(files: File[]): Promise<ImportFile[]> {
  const paths = files.map(
    (f) =>
      ((f as File & { webkitRelativePath?: string }).webkitRelativePath as
        | string
        | undefined) || f.name
  );
  let rootPrefix = "";
  const sample = paths[0];
  if (sample && sample.includes("/")) {
    rootPrefix = sample.split("/")[0] + "/";
  }

  const texts = await Promise.all(files.map((f) => f.text()));
  return files.map((_, i) => {
    let path = paths[i];
    if (rootPrefix && path.startsWith(rootPrefix)) {
      path = path.slice(rootPrefix.length);
    }
    return { path, text: texts[i] };
  });
}
