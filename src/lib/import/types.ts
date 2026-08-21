export interface ImportFile {
  path: string;
  text: string;
}

export interface ParsedDoc {
  path: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  parentTitle: string | null;
  folderPath: string;
  aliases: string[];
  body: string;
}

export interface ImportOptions {
  dialect: "generic" | "notion";
  linkToExisting: boolean;
  createStubs: boolean;
  dryRun: boolean;
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

export type ImportPhase =
  | "cataloging"
  | "folders"
  | "documents"
  | "databases"
  | "links"
  | "done";

export interface ImportProgress {
  phase: ImportPhase;
  current: number;
  total: number;
}

export const DEFAULT_IMPORT_OPTIONS: Omit<ImportOptions, "dialect"> = {
  linkToExisting: true,
  createStubs: false,
  dryRun: false,
  rootFolderId: null,
};

export function emptyImportReport(): ImportReport {
  return {
    foldersCreated: 0,
    docsCreated: 0,
    databasesCreated: 0,
    linksResolved: 0,
    stubsCreated: 0,
    unresolved: [],
    duplicateTitles: [],
    errors: [],
  };
}
