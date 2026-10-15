import { create } from "zustand";
import {
  Document,
  OpenTab,
  ChatMessage,
  ContextItem,
  Annotation,
  AnnotationMessage,
  DbFolder,
  DbDocument,
  TodoItem,
  QuickNoteItem,
} from "./types";
import {
  fetchFolders,
  fetchDocuments,
  fetchDocument,
  createFolder as dbCreateFolder,
  createDocument as dbCreateDocument,
  updateDocument as dbUpdateDocument,
  StaleWriteError,
  deleteDocument as dbDeleteDocument,
  deleteFolder as dbDeleteFolder,
  renameFolder as dbRenameFolder,
  moveDocument as dbMoveDocument,
  moveFolder as dbMoveFolder,
  setParentDocument as dbSetParentDocument,
  propagatePageLinkTitle,
  propagateDatabaseRowTitle,
  dbDocumentToDocument,
  createAnnotation as dbCreateAnnotation,
  fetchAnnotations as dbFetchAnnotations,
  fetchAnnotation as dbFetchAnnotation,
  updateAnnotationMessages as dbUpdateAnnotationMessages,
  deleteAnnotation as dbDeleteAnnotation,
  ensureTodoDocument,
  ensureTodayDailyDocument,
  ensureQuickNoteParentDocument,
  createQuickNote as dbCreateQuickNote,
  fetchTodayQuickNotes,
  createMoodboardState as dbCreateMoodboardState,
} from "./db";
import { v4 as uuidv4 } from "uuid";
import { wouldCreateNestingCycle } from "./treeCycle";

const UNDO_LIMIT = 50;

/** Invalidates in-flight `fetchDocument` for a id so a stale refresh cannot clobber a newer cache. */
const documentFetchGen = new Map<string, number>();
function nextDocumentFetchGen(id: string): number {
  const n = (documentFetchGen.get(id) ?? 0) + 1;
  documentFetchGen.set(id, n);
  return n;
}

export function isNewerTimestamp(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return a > b;
  return da > db;
}

type DocLocation = { folderId: string | null; parentDocId: string | null };
type FolderLocation = { parentId: string | null; parentDocumentId: string | null };

type MoveStep =
  | { kind: "doc"; id: string; from: DocLocation; to: DocLocation }
  | { kind: "folder"; id: string; from: FolderLocation; to: FolderLocation };

type UndoCommand = { steps: MoveStep[] };

let skipUndoRecord = false;
let undoGroupDepth = 0;
let undoGroupSteps: MoveStep[] = [];
let undoStack: UndoCommand[] = [];
let redoStack: UndoCommand[] = [];
let lastFileActionAt = 0;

const FILE_UNDO_PRIORITY_MS = 15_000;

let dashboardInitInflight: Promise<void> | null = null;
/** Expanded folders / pages are read from localStorage once; after that memory is the truth. */
let expandedStateLoaded = false;

// ─── Optimistic creates & prefetch ───

/**
 * Inserts still in flight for documents that are already open. Every write to
 * such a document waits for its insert, so the editor can open instantly.
 */
const pendingCreates = new Map<string, Promise<void>>();

function afterCreate(id: string): Promise<void> {
  return pendingCreates.get(id) ?? Promise.resolve();
}

/** Full documents fetched ahead of a click (hover / pointerdown / keyboard). */
const PREFETCH_TTL_MS = 60_000;
const prefetched = new Map<string, { doc: Document; at: number }>();
const prefetchInflight = new Map<string, Promise<Document | null>>();

function fetchDocumentShared(id: string): Promise<Document | null> {
  const inflight = prefetchInflight.get(id);
  if (inflight) return inflight;
  const p = fetchDocument(id)
    .then((row) => {
      if (!row) return null;
      const doc = dbDocumentToDocument(row);
      prefetched.set(id, { doc, at: Date.now() });
      return doc;
    })
    .finally(() => prefetchInflight.delete(id));
  prefetchInflight.set(id, p);
  return p;
}

function takePrefetched(id: string): Document | null {
  const hit = prefetched.get(id);
  if (!hit) return null;
  prefetched.delete(id);
  return Date.now() - hit.at < PREFETCH_TTL_MS ? hit.doc : null;
}

export function shouldHandleFileUndo(kind: "undo" | "redo", inEditor: boolean) {
  const stack = kind === "undo" ? undoStack : redoStack;
  if (stack.length === 0) return false;
  if (!inEditor) return true;
  return Date.now() - lastFileActionAt < FILE_UNDO_PRIORITY_MS;
}

function docLocEqual(a: DocLocation, b: DocLocation) {
  return a.folderId === b.folderId && a.parentDocId === b.parentDocId;
}

function folderLocEqual(a: FolderLocation, b: FolderLocation) {
  return a.parentId === b.parentId && a.parentDocumentId === b.parentDocumentId;
}

function recordMove(step: MoveStep) {
  if (skipUndoRecord) return;
  if (step.kind === "doc" && docLocEqual(step.from, step.to)) return;
  if (step.kind === "folder" && folderLocEqual(step.from, step.to)) return;
  if (undoGroupDepth > 0) {
    undoGroupSteps.push(step);
    return;
  }
  undoStack = [...undoStack, { steps: [step] }].slice(-UNDO_LIMIT);
  redoStack = [];
  lastFileActionAt = Date.now();
}

type DocPlacement = { folder_id: string | null; parent_document_id: string | null };

function patchDocLocation(docId: string, to: DocPlacement) {
  const { _dbDocuments } = useAppStore.getState();
  useAppStore.setState({
    _dbDocuments: _dbDocuments.map((d) => (d.id === docId ? { ...d, ...to } : d)),
  });
}

/** Roll back one failed move, unless something has moved the doc since. */
function revertDocLocation(docId: string, prev: DocPlacement, to: DocPlacement) {
  const { _dbDocuments } = useAppStore.getState();
  useAppStore.setState({
    _dbDocuments: _dbDocuments.map((d) =>
      d.id === docId && d.folder_id === to.folder_id && d.parent_document_id === to.parent_document_id
        ? { ...d, folder_id: prev.folder_id, parent_document_id: prev.parent_document_id }
        : d
    ),
  });
}

// ─── LocalStorage Cache Helpers ───

const CACHE_KEYS = {
  DB_FOLDERS: "cortex:cache:dbFolders",
  DB_DOCUMENTS: "cortex:cache:dbDocuments",
  OPEN_TABS: "cortex:cache:openTabs",
  ACTIVE_DOC_ID: "cortex:cache:activeDocumentId",
  EXPANDED_FOLDERS: "cortex:cache:expandedFolderIds",
  EXPANDED_DOCS: "cortex:cache:expandedDocIds",
  TIMESTAMP: "cortex:cache:timestamp",
} as const;

function cacheWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function cacheRead<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Strip heavy fields (content, settings) from DbDocuments for sidebar cache. */
function stripDocContent(docs: DbDocument[]): DbDocument[] {
  return docs.map((d) => ({
    ...d,
    content: "[]", // don't cache full content — just need metadata for sidebar tree
  }));
}

/** Persist sidebar hierarchy + workspace state to localStorage. */
function persistSidebarCache(state: {
  _dbFolders: DbFolder[];
  _dbDocuments: DbDocument[];
}): void {
  cacheWrite(CACHE_KEYS.DB_FOLDERS, state._dbFolders);
  cacheWrite(CACHE_KEYS.DB_DOCUMENTS, stripDocContent(state._dbDocuments));
  cacheWrite(CACHE_KEYS.TIMESTAMP, Date.now());
}

/** Persist open tabs and active document to localStorage. */
function persistWorkspaceState(state: {
  openTabs: OpenTab[];
  activeDocumentId: string | null;
}): void {
  cacheWrite(CACHE_KEYS.OPEN_TABS, state.openTabs);
  cacheWrite(CACHE_KEYS.ACTIVE_DOC_ID, state.activeDocumentId);
}

/** Persist which folders and parent documents are expanded in the sidebar. */
function persistExpandedState(state: {
  expandedFolderIds: Set<string>;
  expandedDocIds: Set<string>;
}): void {
  cacheWrite(CACHE_KEYS.EXPANDED_FOLDERS, [...state.expandedFolderIds]);
  cacheWrite(CACHE_KEYS.EXPANDED_DOCS, [...state.expandedDocIds]);
}

/** Load cached sidebar data. Returns null if no cache or cache is too old. */
function loadSidebarCache(): {
  dbFolders: DbFolder[];
  dbDocuments: DbDocument[];
} | null {
  const ts = cacheRead<number>(CACHE_KEYS.TIMESTAMP);
  if (!ts) return null;
  // Consider cache stale after 7 days (we'll always revalidate anyway)
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - ts > MAX_AGE_MS) return null;

  const dbFolders = cacheRead<DbFolder[]>(CACHE_KEYS.DB_FOLDERS);
  const dbDocuments = cacheRead<DbDocument[]>(CACHE_KEYS.DB_DOCUMENTS);
  if (!dbFolders || !dbDocuments) return null;

  return { dbFolders, dbDocuments };
}

function loadWorkspaceState(): {
  openTabs: OpenTab[];
  activeDocumentId: string | null;
} | null {
  const openTabs = cacheRead<OpenTab[]>(CACHE_KEYS.OPEN_TABS);
  const activeDocumentId = cacheRead<string | null>(CACHE_KEYS.ACTIVE_DOC_ID);
  if (!openTabs) return null;
  return { openTabs, activeDocumentId: activeDocumentId ?? null };
}

function loadExpandedState(): {
  expandedFolderIds: Set<string>;
  expandedDocIds: Set<string>;
} {
  return {
    expandedFolderIds: new Set(cacheRead<string[]>(CACHE_KEYS.EXPANDED_FOLDERS) ?? []),
    expandedDocIds: new Set(cacheRead<string[]>(CACHE_KEYS.EXPANDED_DOCS) ?? []),
  };
}

interface AppState {
  // Data
  expandedFolderIds: Set<string>;
  /** Parent documents whose sub-pages are shown in the sidebar. */
  expandedDocIds: Set<string>;
  openTabs: OpenTab[];
  activeDocumentId: string | null;
  activeDocument: Document | null;
  isChatOpen: boolean;
  isGraphOpen: boolean;
  chatMessages: ChatMessage[];
  contextItems: ContextItem[];
  activeAnnotation: Annotation | null;
  documentAnnotations: Annotation[];
  isLoading: boolean;

  // Navigation history
  navHistory: string[];
  navIndex: number;
  _isNavigating: boolean;

  // Caches
  _documentCache: Map<string, Document>;
  _annotationsCache: Map<string, Annotation[]>;

  // Raw db rows — the sidebar derives its tree from these (see lib/fileTree.ts)
  _dbFolders: DbFolder[];
  _dbDocuments: DbDocument[];

  // Actions
  initialize: () => Promise<void>;
  /** Legacy hook kept for callers that patch `_dbDocuments` directly; the sidebar re-derives on its own. */
  _rebuildTree: () => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  toggleFolder: (folderId: string) => void;
  toggleDocExpanded: (docId: string) => void;
  /** Expand or collapse many folders / parent docs in one update. */
  setTreeExpanded: (ids: { folderIds?: string[]; docIds?: string[] }, expanded: boolean) => void;
  openDocument: (docId: string) => Promise<void>;
  /** Warm the document cache ahead of a likely open (hover, pointerdown, keyboard). */
  prefetchDocument: (docId: string) => void;
  closeTab: (docId: string) => void;
  setActiveTab: (docId: string) => Promise<void>;
  /** Returns the new folder's id immediately; the insert finishes in the background. */
  createFolder: (name: string, parentId?: string | null) => string;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createDocument: (
    folderId?: string | null,
    docType?: import("./types").DocType,
    /** `exactFolder`: a null folder means the top level, not the open page's folder. */
    opts?: { parentDocumentId?: string | null; exactFolder?: boolean }
  ) => Promise<string>;
  saveDocument: (
    id: string,
    updates: Partial<{
      title: string;
      subtitle: string | null;
      content: string;
      tags: string[];
      settings: import("./types").NoteSettings;
      expectedUpdatedAt: string;
    }>
  ) => Promise<Document>;
  deleteDocument: (id: string) => Promise<void>;
  moveDocument: (docId: string, folderId: string | null) => Promise<void>;
  moveFolder: (folderId: string, parentId: string | null, parentDocumentId?: string | null) => Promise<void>;
  setParentDocument: (docId: string, parentDocId: string | null) => Promise<void>;
  toggleChat: () => void;
  openGraph: () => void;
  closeGraph: () => void;
  toggleGraph: () => void;
  expandFolders: (folderIds: string[]) => void;
  addChatMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => void;
  addContextItem: (item: ContextItem) => void;
  removeContextItem: (item: ContextItem) => void;
  clearContextItems: () => void;
  openAnnotationChat: (
    documentId: string,
    blockId: string | null,
    highlightedText: string
  ) => Promise<void>;
  closeAnnotationChat: () => void;
  addAnnotationMessage: (content: string, role: "user" | "assistant") => Promise<void>;
  loadAnnotations: (documentId: string) => Promise<void>;
  openExistingAnnotation: (annotation: Annotation) => Promise<void>;
  deleteAnnotationById: (id: string) => Promise<void>;
  openDriveFile: (file: { id: string; name: string; mimeType: string; webViewLink: string | null }) => void;

  // Dashboard
  todoDocId: string | null;
  todoItems: TodoItem[];
  dailyDocId: string | null;
  dailyDocTitle: string;
  dailyDocContent: string;
  quickNoteParentId: string | null;
  quickNotes: QuickNoteItem[];
  dashboardReady: boolean;
  initDashboard: () => Promise<void>;
  addTodo: (text: string) => Promise<void>;
  toggleTodo: (blockId: string) => Promise<void>;
  addQuickNote: (text: string) => Promise<void>;

  // File-tree undo (move document / folder)
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  runUndoable: (fn: () => Promise<void>) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  expandedFolderIds: new Set<string>(),
  expandedDocIds: new Set<string>(),
  openTabs: [],
  activeDocumentId: null,
  activeDocument: null,
  isChatOpen: false,
  isGraphOpen: false,
  chatMessages: [],
  contextItems: [],
  activeAnnotation: null,
  documentAnnotations: [],
  isLoading: true,
  navHistory: [],
  navIndex: -1,
  _isNavigating: false,
  _documentCache: new Map(),
  _annotationsCache: new Map(),
  _dbFolders: [],
  _dbDocuments: [],

  // Dashboard state
  todoDocId: null,
  todoItems: [],
  dailyDocId: null,
  dailyDocTitle: "",
  dailyDocContent: "[]",
  quickNoteParentId: null,
  quickNotes: [],
  dashboardReady: false,

  /** The sidebar derives its tree from `_dbFolders` / `_dbDocuments` and the cache
   *  persister watches them, so there is nothing to rebuild. Kept so existing
   *  callers (`setState({ _dbDocuments })` then `_rebuildTree()`) keep working. */
  _rebuildTree: () => {},

  canGoBack: () => get().navIndex > 0,
  canGoForward: () => get().navIndex < get().navHistory.length - 1,

  goBack: async () => {
    const { navIndex, navHistory } = get();
    if (navIndex <= 0) return;
    const newIndex = navIndex - 1;
    set({ navIndex: newIndex, _isNavigating: true });
    await get().setActiveTab(navHistory[newIndex]);
    set({ _isNavigating: false });
  },

  goForward: async () => {
    const { navIndex, navHistory } = get();
    if (navIndex >= navHistory.length - 1) return;
    const newIndex = navIndex + 1;
    set({ navIndex: newIndex, _isNavigating: true });
    await get().setActiveTab(navHistory[newIndex]);
    set({ _isNavigating: false });
  },

  initialize: async () => {
    try {
      // ── Phase 1: Instant restore from localStorage cache ──
      // A re-run (e.g. after the chat creates a note) must not read back state
      // older than what is in memory, so write out anything still pending first.
      flushPersist();
      const cached = loadSidebarCache();
      const workspace = loadWorkspaceState();
      if (!expandedStateLoaded) {
        expandedStateLoaded = true;
        set(loadExpandedState());
      }

      if (cached) {
        set({
          _dbFolders: cached.dbFolders,
          _dbDocuments: cached.dbDocuments,
          isLoading: false,
          // Restore open tabs + active doc from cache
          ...(workspace ? {
            openTabs: workspace.openTabs,
            activeDocumentId: workspace.activeDocumentId,
          } : {}),
        });

        // If we restored an active doc, load it into the document cache
        if (workspace?.activeDocumentId && !workspace.activeDocumentId.startsWith("drive:")) {
          fetchDocument(workspace.activeDocumentId).then((dbDoc) => {
            if (!dbDoc) return;
            const doc = dbDocumentToDocument(dbDoc);
            const existing = get()._documentCache.get(doc.id);
            if (isNewerTimestamp(existing?.updatedAt, doc.updatedAt)) return;
            const cache = new Map(get()._documentCache);
            cache.set(doc.id, doc);
            if (get().activeDocumentId === doc.id) {
              set({ activeDocument: doc, _documentCache: cache });
            } else {
              set({ _documentCache: cache });
            }
          });
        }
      }

      // ── Phase 2: Revalidate from Supabase (always runs) ──
      const [dbFolders, dbDocuments] = await Promise.all([
        fetchFolders(),
        fetchDocuments(),
      ]);

      // Keep rows created optimistically while the fetch was in flight.
      const fetchedIds = new Set([...dbDocuments, ...dbFolders].map((r) => r.id));
      const pendingDocs = get()._dbDocuments.filter(
        (d) => pendingCreates.has(d.id) && !fetchedIds.has(d.id)
      );
      const pendingFolders = get()._dbFolders.filter(
        (f) => pendingCreates.has(f.id) && !fetchedIds.has(f.id)
      );

      set({
        _dbFolders: pendingFolders.length ? [...dbFolders, ...pendingFolders] : dbFolders,
        _dbDocuments: pendingDocs.length ? [...dbDocuments, ...pendingDocs] : dbDocuments,
        isLoading: false,
      });

      // If tabs were restored from cache, validate they still exist
      const { openTabs } = get();
      if (openTabs.length > 0) {
        const docIds = new Set(get()._dbDocuments.map((d) => d.id));
        const validTabs = openTabs.filter(
          (t) => t.driveFile || docIds.has(t.documentId)
        );
        if (validTabs.length !== openTabs.length) {
          set({ openTabs: validTabs });
          // If active doc was removed, switch to last valid tab
          if (get().activeDocumentId && !docIds.has(get().activeDocumentId!)) {
            const lastTab = validTabs[validTabs.length - 1];
            if (lastTab) {
              await get().setActiveTab(lastTab.documentId);
            } else {
              set({ activeDocumentId: null, activeDocument: null });
            }
          }
        }
      }
    } catch (err) {
      console.error("Failed to initialize:", err);
      set({ isLoading: false });
    }
  },

  toggleFolder: (folderId: string) => {
    const next = new Set(get().expandedFolderIds);
    if (!next.delete(folderId)) next.add(folderId);
    set({ expandedFolderIds: next });
  },

  toggleDocExpanded: (docId: string) => {
    const next = new Set(get().expandedDocIds);
    if (!next.delete(docId)) next.add(docId);
    set({ expandedDocIds: next });
  },

  setTreeExpanded: ({ folderIds = [], docIds = [] }, expanded) => {
    const apply = (current: Set<string>, ids: string[]) => {
      if (ids.length === 0) return current;
      const next = new Set(current);
      let changed = false;
      for (const id of ids) {
        if (expanded ? !next.has(id) : next.has(id)) {
          if (expanded) next.add(id);
          else next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    };
    const { expandedFolderIds, expandedDocIds } = get();
    const nextFolders = apply(expandedFolderIds, folderIds);
    const nextDocs = apply(expandedDocIds, docIds);
    if (nextFolders === expandedFolderIds && nextDocs === expandedDocIds) return;
    set({ expandedFolderIds: nextFolders, expandedDocIds: nextDocs });
  },

  prefetchDocument: (docId: string) => {
    if (docId.startsWith("drive:")) return;
    if (get()._documentCache.has(docId) || pendingCreates.has(docId)) return;
    const hit = prefetched.get(docId);
    if (hit && Date.now() - hit.at < PREFETCH_TTL_MS / 2) return;
    void fetchDocumentShared(docId).catch(() => {});
  },

  openDocument: async (docId: string) => {
    const { openTabs, _isNavigating, navHistory, navIndex } = get();
    if (get().isGraphOpen) set({ isGraphOpen: false });
    const existing = openTabs.find((t) => t.documentId === docId);

    // Push to nav history (unless we're navigating via back/forward)
    if (!_isNavigating) {
      const trimmed = navHistory.slice(0, navIndex + 1);
      set({ navHistory: [...trimmed, docId], navIndex: trimmed.length });
    }

    if (!existing) {
      // Open the tab and move the selection now; the content follows. A
      // prefetched copy renders instantly and is revalidated in the background,
      // the same way setActiveTab treats its cache.
      const fetchGen = nextDocumentFetchGen(docId);
      const meta = get()._dbDocuments.find((d) => d.id === docId);
      const warm = get()._documentCache.get(docId) ?? takePrefetched(docId);
      const cache = new Map(get()._documentCache);
      if (warm) cache.set(docId, warm);
      set({
        openTabs: [...get().openTabs, { documentId: docId, title: warm?.title ?? meta?.title ?? "Untitled" }],
        activeDocumentId: docId,
        activeDocument: warm ?? null,
        activeAnnotation: null,
        _documentCache: cache,
        ...(get()._annotationsCache.get(docId)
          ? { documentAnnotations: get()._annotationsCache.get(docId)! }
          : {}),
      });
      void get().loadAnnotations(docId);
      if (pendingCreates.has(docId)) return;

      let fresh: Document | null;
      try {
        fresh = await fetchDocumentShared(docId);
      } catch (err) {
        console.error("Failed to open document:", err);
        fresh = null;
        if (warm) return;
      }
      if (documentFetchGen.get(docId) !== fetchGen) return;
      if (!fresh) {
        // Gone (deleted elsewhere) — drop the tab we just opened.
        if (get().openTabs.some((t) => t.documentId === docId)) get().closeTab(docId);
        return;
      }
      prefetched.delete(docId);
      const current = get()._documentCache.get(docId);
      if (current && isNewerTimestamp(current.updatedAt, fresh.updatedAt)) return;
      const next = new Map(get()._documentCache);
      next.set(docId, fresh);
      set({
        _documentCache: next,
        ...(get().activeDocumentId === docId ? { activeDocument: fresh } : {}),
      });
    } else {
      // Skip the history push inside setActiveTab since we already pushed above
      set({ _isNavigating: true });
      await get().setActiveTab(docId);
      set({ _isNavigating: false });
    }
  },

  closeTab: (docId: string) => {
    const { openTabs, activeDocumentId } = get();
    const newTabs = openTabs.filter((t) => t.documentId !== docId);

    if (activeDocumentId === docId) {
      const lastTab = newTabs[newTabs.length - 1];
      if (lastTab) {
        get().setActiveTab(lastTab.documentId);
      } else {
        set({
          openTabs: newTabs,
          activeDocumentId: null,
          activeDocument: null,
        });
      }
    }

    set({ openTabs: newTabs });

    if (docId.startsWith("drive:")) return;

    const docCache = new Map(get()._documentCache);
    const annCache = new Map(get()._annotationsCache);
    docCache.delete(docId);
    annCache.delete(docId);
    set({ _documentCache: docCache, _annotationsCache: annCache });
  },

  setActiveTab: async (docId: string) => {
    if (get().isGraphOpen) set({ isGraphOpen: false });
    const existingTab = get().openTabs.find((t) => t.documentId === docId);
    if (existingTab?.driveFile || docId.startsWith("drive:")) {
      const { _isNavigating, navHistory, navIndex } = get();
      if (!_isNavigating) {
        const trimmed = navHistory.slice(0, navIndex + 1);
        set({ navHistory: [...trimmed, docId], navIndex: trimmed.length });
      }
      set({
        activeDocumentId: docId,
        activeDocument: null,
        activeAnnotation: null,
      });
      return;
    }
    const { _isNavigating, navHistory, navIndex, _documentCache, _annotationsCache } = get();
    // Push to nav history (unless we're navigating via back/forward)
    if (!_isNavigating) {
      const trimmed = navHistory.slice(0, navIndex + 1);
      set({ navHistory: [...trimmed, docId], navIndex: trimmed.length });
    }

    // Instantly swap to cached version if available
    const cached = _documentCache.get(docId);
    const cachedAnnotations = _annotationsCache.get(docId);
    const fetchGen = nextDocumentFetchGen(docId);
    if (cached) {
      set({
        activeDocumentId: cached.id,
        activeDocument: cached,
        activeAnnotation: null,
        ...(cachedAnnotations ? { documentAnnotations: cachedAnnotations } : {}),
      });
      // Refresh from DB in the background (don't await)
      fetchDocument(docId).then((dbDoc) => {
        if (!dbDoc) return;
        if (documentFetchGen.get(docId) !== fetchGen) return;
        const doc = dbDocumentToDocument(dbDoc);
        const existing = get()._documentCache.get(doc.id);
        if (isNewerTimestamp(existing?.updatedAt, doc.updatedAt)) return;

        const cache = new Map(get()._documentCache);
        cache.set(doc.id, doc);
        const stillOpen = get().openTabs.length > 0 && get().activeDocumentId === doc.id;
        if (get().activeDocumentId === doc.id && stillOpen) {
          set({ activeDocument: doc, _documentCache: cache });
        } else {
          set({ _documentCache: cache });
        }
      });
      get().loadAnnotations(docId); // fire-and-forget
      return;
    }

    // No cache — fetch and cache
    const dbDoc = await fetchDocument(docId);
    if (!dbDoc) return;
    if (documentFetchGen.get(docId) !== fetchGen) return;
    const doc = dbDocumentToDocument(dbDoc);
    const cache = new Map(get()._documentCache);
    cache.set(doc.id, doc);
    if (get().openTabs.length === 0) {
      set({ _documentCache: cache });
      return;
    }
    set({ activeDocumentId: doc.id, activeDocument: doc, activeAnnotation: null, _documentCache: cache });
    await get().loadAnnotations(doc.id);
  },

  createFolder: (name: string, parentId: string | null = null) => {
    // Optimistic: the local row already carries the id the insert will use,
    // so nothing has to be swapped when the server answers.
    const now = new Date().toISOString();
    const tempFolder: DbFolder = {
      id: uuidv4(),
      name,
      parent_id: parentId,
      parent_document_id: null,
      user_id: "local",
      position: 0,
      created_at: now,
      updated_at: now,
    };
    const expanded =
      parentId && !get().expandedFolderIds.has(parentId)
        ? { expandedFolderIds: new Set(get().expandedFolderIds).add(parentId) }
        : {};
    set({ _dbFolders: [...get()._dbFolders, tempFolder], ...expanded });
    const insert = dbCreateFolder(name, parentId, tempFolder.id).then(
      (realFolder) => {
        // Keep anything the user changed locally while the insert was in flight.
        set({
          _dbFolders: get()._dbFolders.map((f) =>
            f.id === tempFolder.id
              ? { ...realFolder, name: f.name, parent_id: f.parent_id, parent_document_id: f.parent_document_id }
              : f
          ),
        });
      },
      (err) => {
        console.error("Failed to create folder:", err);
        set({ _dbFolders: get()._dbFolders.filter((f) => f.id !== tempFolder.id) });
        throw err;
      }
    );
    pendingCreates.set(tempFolder.id, insert);
    insert.then(
      () => pendingCreates.delete(tempFolder.id),
      () => pendingCreates.delete(tempFolder.id)
    );
    return tempFolder.id;
  },

  renameFolder: async (id: string, name: string) => {
    const { _dbFolders } = get();
    const prev = _dbFolders;
    set({ _dbFolders: _dbFolders.map((f) => f.id === id ? { ...f, name, updated_at: new Date().toISOString() } : f) });
    afterCreate(id)
      .then(() => dbRenameFolder(id, name))
      .catch((err) => {
        console.error("Failed to rename folder:", err);
        set({ _dbFolders: prev });
      });
  },

  deleteFolder: async (id: string) => {
    const { _dbFolders, _dbDocuments } = get();
    const snapshotFolders = _dbFolders;
    const snapshotDocs = _dbDocuments;
    const folder = _dbFolders.find((f) => f.id === id);
    const hoistParent = folder?.parent_id ?? null;
    set({
      _dbFolders: _dbFolders
        .filter((f) => f.id !== id)
        .map((f) => (f.parent_id === id ? { ...f, parent_id: hoistParent } : f)),
      _dbDocuments: _dbDocuments.map((d) =>
        d.folder_id === id ? { ...d, folder_id: null } : d
      ),
    });
    afterCreate(id)
      .then(() => dbDeleteFolder(id))
      .catch((err) => {
        console.error("Failed to delete folder:", err);
        set({ _dbFolders: snapshotFolders, _dbDocuments: snapshotDocs });
      });
  },

  createDocument: async (
    folderId: string | null = null,
    docType: import("./types").DocType = "note",
    opts?: { parentDocumentId?: string | null; exactFolder?: boolean }
  ) => {
    const state = get();
    const parentDocumentId = opts?.parentDocumentId ?? null;
    const parentDoc = parentDocumentId
      ? state._dbDocuments.find((d) => d.id === parentDocumentId) ?? null
      : null;
    let targetFolderId = parentDoc ? parentDoc.folder_id : folderId;
    if (targetFolderId === null && !parentDoc && !opts?.exactFolder) {
      targetFolderId =
        state.activeDocument?.folderId ??
        state._dbDocuments.find((d) => d.id === state.activeDocumentId)?.folder_id ??
        null;
    }

    // Reveal where the new page lands.
    const expandFolder = targetFolderId && !state.expandedFolderIds.has(targetFolderId);
    const expandParent = parentDocumentId && !state.expandedDocIds.has(parentDocumentId);

    // Optimistic: the local row carries the id the insert will use, and the
    // editor opens on it right away. Writes to it wait for the insert
    // (`afterCreate`), so typing never races the row into existence.
    const now = new Date().toISOString();
    const title = docType === "moodboard" ? "Untitled Moodboard" : "Untitled";
    const tempDoc: DbDocument = {
      id: uuidv4(),
      title,
      subtitle: null,
      folder_id: targetFolderId,
      parent_document_id: parentDocumentId,
      user_id: "local",
      content: "[]",
      tags: [],
      settings: {},
      doc_type: docType,
      position: 0,
      share_slug: null,
      created_at: now,
      updated_at: now,
    };
    const id = tempDoc.id;
    set({
      _dbDocuments: [...get()._dbDocuments, tempDoc],
      ...(expandFolder ? { expandedFolderIds: new Set(get().expandedFolderIds).add(targetFolderId!) } : {}),
      ...(expandParent ? { expandedDocIds: new Set(get().expandedDocIds).add(parentDocumentId!) } : {}),
    });

    const insert = (async () => {
      const dbDoc = await dbCreateDocument(targetFolderId, title, "[]", parentDocumentId, docType, [], id);
      // A moodboard needs its companion state row before the canvas loads.
      if (docType === "moodboard") {
        try {
          await dbCreateMoodboardState(dbDoc.id);
        } catch (err) {
          console.error("Failed to create moodboard state:", err);
        }
      }
      // Reconcile server fields, keeping local edits to title / placement, and
      // hand the open editor the server's timestamp so its first save matches.
      const stamp = { createdAt: dbDoc.created_at, updatedAt: dbDoc.updated_at };
      const cache = new Map(get()._documentCache);
      const cached = cache.get(id);
      if (cached) cache.set(id, { ...cached, ...stamp });
      const active = get().activeDocument;
      set({
        _dbDocuments: get()._dbDocuments.map((d) =>
          d.id === id
            ? { ...d, created_at: dbDoc.created_at, updated_at: dbDoc.updated_at, user_id: dbDoc.user_id }
            : d
        ),
        _documentCache: cache,
        ...(active?.id === id ? { activeDocument: { ...active, ...stamp } } : {}),
      });
    })();
    pendingCreates.set(id, insert);
    insert.then(
      () => pendingCreates.delete(id),
      (err) => {
        pendingCreates.delete(id);
        console.error("Failed to create document:", err);
        set({ _dbDocuments: get()._dbDocuments.filter((d) => d.id !== id) });
        if (get().openTabs.some((t) => t.documentId === id)) get().closeTab(id);
      }
    );

    // The moodboard canvas reads its state row on mount, so wait for it.
    if (docType === "moodboard") await insert;

    const doc = dbDocumentToDocument(get()._dbDocuments.find((d) => d.id === id) ?? tempDoc);
    const { _isNavigating, navHistory, navIndex } = get();
    const cache = new Map(get()._documentCache);
    cache.set(id, doc);
    set({
      isGraphOpen: false,
      openTabs: [...get().openTabs, { documentId: id, title }],
      activeDocumentId: id,
      activeDocument: doc,
      activeAnnotation: null,
      documentAnnotations: [],
      _documentCache: cache,
      ...(_isNavigating
        ? {}
        : { navHistory: [...navHistory.slice(0, navIndex + 1), id], navIndex: navIndex + 1 }),
    });
    return id;
  },

  saveDocument: async (id, updates) => {
    const { expectedUpdatedAt, ...fields } = updates;

    // Show a new title in the sidebar and tab bar immediately; revert only if
    // the write fails outright (a stale write is retried or held by the editor).
    const prevTitle =
      fields.title !== undefined
        ? get()._dbDocuments.find((d) => d.id === id)?.title
        : undefined;
    const applyTitle = (title: string) =>
      set({
        _dbDocuments: get()._dbDocuments.map((d) => (d.id === id ? { ...d, title } : d)),
        openTabs: get().openTabs.map((t) => (t.documentId === id ? { ...t, title } : t)),
      });
    if (fields.title && fields.title !== prevTitle) applyTitle(fields.title);

    let saved: DbDocument;
    try {
      await afterCreate(id);
      // Throws StaleWriteError when expectedUpdatedAt no longer matches the row.
      saved = await dbUpdateDocument(
        id,
        fields,
        expectedUpdatedAt ? { expectedUpdatedAt } : undefined
      );
    } catch (err) {
      if (
        fields.title &&
        prevTitle !== undefined &&
        !(err instanceof StaleWriteError) &&
        get()._dbDocuments.find((d) => d.id === id)?.title === fields.title
      ) {
        applyTitle(prevTitle);
      }
      throw err;
    }

    const mapped = dbDocumentToDocument(saved);

    // Update active document and cache
    const { activeDocument, _documentCache } = get();
    if (activeDocument && activeDocument.id === id) {
      const updated = { ...activeDocument, ...fields, updatedAt: mapped.updatedAt };
      if (fields.content !== undefined) updated.content = mapped.content;
      const cache = new Map(_documentCache);
      cache.set(id, updated);
      set({ activeDocument: updated, _documentCache: cache });
    } else if (_documentCache.has(id)) {
      const cache = new Map(_documentCache);
      cache.set(id, {
        ...(_documentCache.get(id) as Document),
        ...fields,
        updatedAt: mapped.updatedAt,
      });
      set({ _documentCache: cache });
    }
    prefetched.delete(id);

    if (fields.title) {
      const title = fields.title;
      // Rewrite page-link pills and database rows that show this title. These
      // touch other documents, so they run after the save instead of holding it.
      void (async () => {
        try {
          await propagatePageLinkTitle(id, title);
        } catch (err) {
          console.error("Failed to propagate page link title:", err);
        }
        try {
          await propagateDatabaseRowTitle(id, title);
        } catch (err) {
          console.error("Failed to propagate database row title:", err);
        }
      })();
    }

    return mapped;
  },

  deleteDocument: async (id: string) => {
    const { _dbDocuments: docs, _dbFolders: folders } = get();
    const snapshotDocs = docs;
    const snapshotFolders = folders;
    const idsToDelete = new Set<string>();
    const collect = (docId: string) => {
      idsToDelete.add(docId);
      for (const d of docs) {
        if (d.parent_document_id === docId && !idsToDelete.has(d.id)) collect(d.id);
      }
    };
    collect(id);
    for (const docId of idsToDelete) {
      if (get().openTabs.some((t) => t.documentId === docId)) get().closeTab(docId);
      prefetched.delete(docId);
    }
    set({
      _dbDocuments: docs.filter((d) => !idsToDelete.has(d.id)),
      _dbFolders: folders.map((f) =>
        f.parent_document_id && idsToDelete.has(f.parent_document_id)
          ? { ...f, parent_document_id: null }
          : f
      ),
    });
    afterCreate(id)
      .then(() => dbDeleteDocument(id))
      .catch((err) => {
        console.error("Failed to delete document:", err);
        set({ _dbDocuments: snapshotDocs, _dbFolders: snapshotFolders });
      });
  },

  moveDocument: async (docId: string, folderId: string | null) => {
    const prev = get()._dbDocuments.find((d) => d.id === docId);
    if (!prev) return;
    if (prev.folder_id === folderId && !prev.parent_document_id) return;
    recordMove({
      kind: "doc",
      id: docId,
      from: { folderId: prev.folder_id, parentDocId: prev.parent_document_id },
      to: { folderId, parentDocId: null },
    });
    patchDocLocation(docId, { folder_id: folderId, parent_document_id: null });
    try {
      await afterCreate(docId);
      await dbMoveDocument(docId, folderId);
    } catch (err) {
      console.error("Failed to move document:", err);
      revertDocLocation(docId, prev, { folder_id: folderId, parent_document_id: null });
    }
  },

  moveFolder: async (folderId: string, parentId: string | null, parentDocumentId: string | null = null) => {
    const { _dbFolders, _dbDocuments } = get();
    if (
      wouldCreateNestingCycle(_dbFolders, _dbDocuments, {
        kind: "folder",
        id: folderId,
        parentId,
        parentDocumentId,
      })
    ) {
      console.warn("[store] refused folder move that would create a cycle");
      return;
    }
    const prev = _dbFolders.find((f) => f.id === folderId);
    if (!prev) return;
    if (prev.parent_id === parentId && prev.parent_document_id === parentDocumentId) return;
    recordMove({
      kind: "folder",
      id: folderId,
      from: { parentId: prev.parent_id, parentDocumentId: prev.parent_document_id },
      to: { parentId, parentDocumentId },
    });
    const to = { parent_id: parentId, parent_document_id: parentDocumentId };
    set({
      _dbFolders: get()._dbFolders.map((f) => (f.id === folderId ? { ...f, ...to } : f)),
    });
    try {
      await afterCreate(folderId);
      await dbMoveFolder(folderId, parentId, parentDocumentId);
    } catch (err) {
      console.error("Failed to move folder:", err);
      // Undo only this move, and only if nothing has moved the folder since.
      set({
        _dbFolders: get()._dbFolders.map((f) =>
          f.id === folderId && f.parent_id === to.parent_id && f.parent_document_id === to.parent_document_id
            ? { ...f, parent_id: prev.parent_id, parent_document_id: prev.parent_document_id }
            : f
        ),
      });
    }
  },

  setParentDocument: async (docId: string, parentDocId: string | null) => {
    const { _dbFolders, _dbDocuments } = get();
    const prev = _dbDocuments.find((d) => d.id === docId);
    if (!prev) return;
    const parentDoc = parentDocId ? _dbDocuments.find((d) => d.id === parentDocId) : null;
    if (
      wouldCreateNestingCycle(_dbFolders, _dbDocuments, {
        kind: "doc",
        id: docId,
        parentDocId,
        folderId: parentDoc ? parentDoc.folder_id : undefined,
      })
    ) {
      console.warn("[store] refused document nest that would create a cycle");
      return;
    }
    const to = {
      folder_id: parentDoc ? parentDoc.folder_id : prev.folder_id,
      parent_document_id: parentDocId,
    };
    if (prev.folder_id === to.folder_id && prev.parent_document_id === to.parent_document_id) return;
    recordMove({
      kind: "doc",
      id: docId,
      from: { folderId: prev.folder_id, parentDocId: prev.parent_document_id },
      to: { folderId: to.folder_id, parentDocId },
    });
    patchDocLocation(docId, to);
    try {
      await afterCreate(docId);
      if (parentDocId) await afterCreate(parentDocId);
      await dbSetParentDocument(docId, parentDocId, parentDoc ? parentDoc.folder_id : undefined);
    } catch (err) {
      console.error("Failed to nest document:", err);
      revertDocLocation(docId, prev, to);
    }
  },

  runUndoable: async (fn) => {
    undoGroupDepth += 1;
    if (undoGroupDepth === 1) undoGroupSteps = [];
    try {
      await fn();
    } finally {
      undoGroupDepth -= 1;
      if (undoGroupDepth === 0 && undoGroupSteps.length > 0) {
        undoStack = [...undoStack, { steps: undoGroupSteps }].slice(-UNDO_LIMIT);
        redoStack = [];
        undoGroupSteps = [];
        lastFileActionAt = Date.now();
      }
    }
  },

  undo: async () => {
    const command = undoStack[undoStack.length - 1];
    if (!command) return;
    undoStack = undoStack.slice(0, -1);
    skipUndoRecord = true;
    try {
      for (let i = command.steps.length - 1; i >= 0; i--) {
        const step = command.steps[i];
        if (step.kind === "doc") {
          if (step.from.parentDocId) {
            await get().setParentDocument(step.id, step.from.parentDocId);
          } else {
            await get().moveDocument(step.id, step.from.folderId);
          }
        } else {
          await get().moveFolder(step.id, step.from.parentId, step.from.parentDocumentId);
        }
      }
      redoStack = [...redoStack, command];
      lastFileActionAt = Date.now();
    } finally {
      skipUndoRecord = false;
    }
  },

  redo: async () => {
    const command = redoStack[redoStack.length - 1];
    if (!command) return;
    redoStack = redoStack.slice(0, -1);
    skipUndoRecord = true;
    try {
      for (const step of command.steps) {
        if (step.kind === "doc") {
          if (step.to.parentDocId) {
            await get().setParentDocument(step.id, step.to.parentDocId);
          } else {
            await get().moveDocument(step.id, step.to.folderId);
          }
        } else {
          await get().moveFolder(step.id, step.to.parentId, step.to.parentDocumentId);
        }
      }
      undoStack = [...undoStack, command].slice(-UNDO_LIMIT);
      lastFileActionAt = Date.now();
    } finally {
      skipUndoRecord = false;
    }
  },

  toggleChat: () =>
    set((s) => ({
      isChatOpen: !s.isChatOpen,
      // Close annotation chat when opening main chat
      activeAnnotation: !s.isChatOpen ? null : s.activeAnnotation,
    })),

  openGraph: () => set({ isGraphOpen: true }),
  closeGraph: () => set({ isGraphOpen: false }),
  toggleGraph: () => set((s) => ({ isGraphOpen: !s.isGraphOpen })),

  expandFolders: (folderIds: string[]) => {
    get().setTreeExpanded({ folderIds }, true);
  },

  addChatMessage: (msg) => {
    const message: ChatMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, message] }));
  },

  addContextItem: (item) => {
    set((s) => {
      // Prevent duplicates
      const exists = s.contextItems.some((ci) => {
        if (ci.type === "document" && item.type === "document")
          return ci.docId === item.docId;
        if (ci.type === "block" && item.type === "block")
          return ci.blockId === item.blockId;
        if (ci.type === "folder" && item.type === "folder")
          return ci.folderId === item.folderId;
        return false;
      });
      if (exists) return s;
      return { contextItems: [...s.contextItems, item] };
    });
  },

  removeContextItem: (item) => {
    set((s) => ({
      contextItems: s.contextItems.filter((ci) => {
        if (ci.type === "document" && item.type === "document")
          return ci.docId !== item.docId;
        if (ci.type === "block" && item.type === "block")
          return ci.blockId !== item.blockId;
        if (ci.type === "folder" && item.type === "folder")
          return ci.folderId !== item.folderId;
        return true;
      }),
    }));
  },

  clearContextItems: () => set({ contextItems: [] }),

  openAnnotationChat: async (documentId, blockId, highlightedText) => {
    // Close main chat panel
    set({ isChatOpen: false });

    // Check if annotation already exists for this block
    const { documentAnnotations } = get();
    const existing = blockId
      ? documentAnnotations.find((a) => a.blockId === blockId)
      : null;

    if (existing) {
      // Annotations from the list fetch carry empty messages to save egress.
      // Hydrate on open so the chat shows prior history.
      if (existing.messages.length === 0) {
        try {
          const full = await dbFetchAnnotation(existing.id);
          if (full) {
            const hydrated: Annotation = { ...existing, messages: full.messages };
            set({
              activeAnnotation: hydrated,
              documentAnnotations: get().documentAnnotations.map((a) =>
                a.id === hydrated.id ? hydrated : a
              ),
            });
            return;
          }
        } catch (err) {
          console.error("Failed to hydrate annotation messages:", err);
        }
      }
      set({ activeAnnotation: existing });
      return;
    }

    // Create annotation in DB
    try {
      const dbAnnotation = await dbCreateAnnotation(documentId, blockId, highlightedText);
      const annotation: Annotation = {
        id: dbAnnotation.id,
        documentId: dbAnnotation.document_id,
        blockId: dbAnnotation.block_id,
        highlightedText: dbAnnotation.highlighted_text,
        messages: dbAnnotation.messages,
        createdAt: dbAnnotation.created_at,
        updatedAt: dbAnnotation.updated_at,
      };
      set({
        activeAnnotation: annotation,
        documentAnnotations: [...get().documentAnnotations, annotation],
      });
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  },

  closeAnnotationChat: () => {
    set({ activeAnnotation: null });
  },

  addAnnotationMessage: async (content, role) => {
    const { activeAnnotation, documentAnnotations } = get();
    if (!activeAnnotation) return;

    const newMessage: AnnotationMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };
    const updatedMessages = [...activeAnnotation.messages, newMessage];
    const updatedAnnotation = {
      ...activeAnnotation,
      messages: updatedMessages,
    };
    set({
      activeAnnotation: updatedAnnotation,
      documentAnnotations: documentAnnotations.map((a) =>
        a.id === activeAnnotation.id ? updatedAnnotation : a
      ),
    });

    // Persist to DB
    try {
      await dbUpdateAnnotationMessages(activeAnnotation.id, updatedMessages);
    } catch (err) {
      console.error("Failed to save annotation message:", err);
    }
  },

  loadAnnotations: async (documentId) => {
    try {
      const dbAnnotations = await dbFetchAnnotations(documentId); 
      const annotations: Annotation[] = dbAnnotations.map((a) => ({
        id: a.id,
        documentId: a.document_id,
        blockId: a.block_id,
        highlightedText: a.highlighted_text,
        messages: a.messages,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      }));
      set({ documentAnnotations: annotations });
      // Cache annotations
      const aCache = new Map(get()._annotationsCache);
      aCache.set(documentId, annotations);
      set({ _annotationsCache: aCache });
    } catch (err) {
      console.error("Failed to load annotations:", err);
    }
  },

  openExistingAnnotation: async (annotation) => {
    // Annotations from the list fetch carry empty messages to save egress.
    // Hydrate on open so the chat shows prior history.
    set({ isChatOpen: false, activeAnnotation: annotation });
    if (annotation.messages.length > 0) return;
    try {
      const full = await dbFetchAnnotation(annotation.id);
      if (!full) return;
      const hydrated: Annotation = { ...annotation, messages: full.messages };
      // Only update if still viewing this annotation
      if (get().activeAnnotation?.id === hydrated.id) {
        set({ activeAnnotation: hydrated });
      }
      set({
        documentAnnotations: get().documentAnnotations.map((a) =>
          a.id === hydrated.id ? hydrated : a
        ),
      });
    } catch (err) {
      console.error("Failed to hydrate annotation messages:", err);
    }
  },

  deleteAnnotationById: async (id) => {
    const { activeAnnotation, documentAnnotations } = get();
    // Close chat if this annotation is active
    if (activeAnnotation?.id === id) {
      set({ activeAnnotation: null });
    }
    // Remove from local list
    set({
      documentAnnotations: documentAnnotations.filter((a) => a.id !== id),
    });
    // Delete from DB
    try {
      await dbDeleteAnnotation(id);
    } catch (err) {
      console.error("Failed to delete annotation:", err);
    }
  },

  openDriveFile: (file) => {
    const tabId = `drive:${file.id}`;
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.documentId === tabId);

    if (!existing) {
      set({
        openTabs: [
          ...openTabs,
          {
            documentId: tabId,
            title: file.name,
            driveFile: {
              fileId: file.id,
              mimeType: file.mimeType,
              webViewLink: file.webViewLink,
            },
          },
        ],
        activeDocumentId: tabId,
        activeDocument: null,
        activeAnnotation: null,
      });
    } else {
      set({
        activeDocumentId: tabId,
        activeDocument: null,
        activeAnnotation: null,
      });
    }
  },

  // ── Dashboard actions ──────────────────────────────────────────

  initDashboard: async () => {
    if (dashboardInitInflight) return dashboardInitInflight;
    dashboardInitInflight = (async () => {
      try {
        const [todoDoc, dailyDoc] = await Promise.all([
          ensureTodoDocument(),
          ensureTodayDailyDocument(),
        ]);
        const quickNoteParent = await ensureQuickNoteParentDocument();
        const todayQuickNotes = await fetchTodayQuickNotes();

        const todoItems = parseTodoItems(todoDoc.content);

        const quickNotes: QuickNoteItem[] = todayQuickNotes.map((d) => ({
          docId: d.id,
          title: d.title,
          createdAt: d.created_at,
        }));

        set({
          todoDocId: todoDoc.id,
          todoItems,
          dailyDocId: dailyDoc.id,
          dailyDocTitle: dailyDoc.title,
          dailyDocContent: dailyDoc.content,
          quickNoteParentId: quickNoteParent.id,
          quickNotes,
          dashboardReady: true,
        });
      } catch (err) {
        console.error("Failed to initialize dashboard:", err);
        set({ dashboardReady: true });
      }
    })().finally(() => {
      dashboardInitInflight = null;
    });
    return dashboardInitInflight;
  },

  addTodo: async (text: string) => {
    const { todoDocId, todoItems } = get();
    if (!todoDocId || !text.trim()) return;

    const blockId = uuidv4();
    const newItem: TodoItem = { blockId, text: text.trim(), checked: false };

    set({ todoItems: [newItem, ...todoItems] });

    try {
      await persistTodoMutation(todoDocId, (blocks) => {
        if (blocks.some((b) => b.id === blockId)) return;
        blocks.unshift(makeTodoBlock(blockId, text.trim()));
      });
    } catch (err) {
      console.error("Failed to add todo:", err);
      set({ todoItems: get().todoItems.filter((t) => t.blockId !== blockId) });
    }
  },

  toggleTodo: async (blockId: string) => {
    const { todoDocId, todoItems } = get();
    if (!todoDocId) return;

    const prev = todoItems;
    set({
      todoItems: todoItems.map((t) =>
        t.blockId === blockId ? { ...t, checked: !t.checked } : t
      ),
    });

    try {
      await persistTodoMutation(todoDocId, (blocks) => {
        const block = blocks.find((b) => b.id === blockId);
        if (block && block.props) {
          const props = block.props as Record<string, unknown>;
          props.checked = !props.checked;
        }
      });
    } catch (err) {
      console.error("Failed to toggle todo:", err);
      set({ todoItems: prev });
    }
  },

  addQuickNote: async (text: string) => {
    if (!text.trim()) return;

    try {
      const newDoc = await dbCreateQuickNote(text.trim());
      const newItem: QuickNoteItem = {
        docId: newDoc.id,
        title: newDoc.title,
        createdAt: newDoc.created_at,
      };

      // Prepend to the list (newest first)
      set({ quickNotes: [newItem, ...get().quickNotes] });

      // Add the new doc to local state and rebuild tree (no DB re-fetch)
      const dbDoc: DbDocument = {
        id: newDoc.id,
        title: newDoc.title,
        subtitle: null,
        folder_id: newDoc.folder_id,
        parent_document_id: newDoc.parent_document_id,
        user_id: newDoc.user_id,
        content: newDoc.content,
        tags: newDoc.tags ?? [],
        settings: {},
        doc_type: newDoc.doc_type ?? "note",
        position: newDoc.position ?? 0,
        share_slug: newDoc.share_slug ?? null,
        created_at: newDoc.created_at,
        updated_at: newDoc.updated_at,
      };
      set({ _dbDocuments: [...get()._dbDocuments, dbDoc] });
      get()._rebuildTree();
    } catch (err) {
      console.error("Failed to create quick note:", err);
    }
  },
}));

// ── Helpers for todo block parsing ──────────────────────────────

function safeParseBlocks(content: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTodoItems(content: string): TodoItem[] {
  const blocks = safeParseBlocks(content);
  const items: TodoItem[] = [];
  for (const b of blocks) {
    if (b.type !== "checkListItem") continue;
    const props = b.props as Record<string, unknown> | undefined;
    const checked = !!props?.checked;
    // Extract text from content array
    let text = "";
    if (Array.isArray(b.content)) {
      text = (b.content as Array<Record<string, unknown>>)
        .map((c) => (typeof c === "string" ? c : (c.text as string) || ""))
        .join("");
    }
    items.push({ blockId: b.id as string, text, checked });
  }
  return items;
}

function makeTodoBlock(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "checkListItem",
    props: {
      textColor: "default",
      backgroundColor: "default",
      textAlignment: "left",
      checked: false,
    },
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

async function persistTodoMutation(
  todoDocId: string,
  mutate: (blocks: Record<string, unknown>[]) => void
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const dbDoc = await fetchDocument(todoDocId);
    if (!dbDoc) return;
    const blocks = safeParseBlocks(dbDoc.content);
    mutate(blocks);
    const content = JSON.stringify(blocks);
    try {
      const saved = await dbUpdateDocument(
        todoDocId,
        { content },
        { expectedUpdatedAt: dbDoc.updated_at }
      );
      // Carry the new updated_at along with the content so an open editor can
      // adopt this write as its own instead of treating it as a stale conflict.
      prefetched.delete(todoDocId);
      const state = useAppStore.getState();
      const cache = new Map(state._documentCache);
      const patch = { content, updatedAt: saved.updated_at };
      if (cache.has(todoDocId)) {
        cache.set(todoDocId, { ...cache.get(todoDocId)!, ...patch });
      }
      const active = state.activeDocument;
      useAppStore.setState({
        _documentCache: cache,
        ...(active && active.id === todoDocId
          ? { activeDocument: { ...active, ...patch } }
          : {}),
      });
      return;
    } catch (err) {
      if (err instanceof StaleWriteError && attempt < 2) continue;
      throw err;
    }
  }
}

// ─── Auto-persist state changes to localStorage ───
// Uses Zustand subscribe to watch for changes without modifying individual actions.
// Each slice is marked dirty when it changes and written once the main thread is
// idle, so a burst of updates costs one write and no change is ever dropped.

const dirty = { sidebar: false, workspace: false, expanded: false };
let persistScheduled = false;

function flushPersist() {
  if (!persistScheduled) return;
  persistScheduled = false;
  const state = useAppStore.getState();
  if (dirty.sidebar) persistSidebarCache(state);
  if (dirty.workspace) persistWorkspaceState(state);
  if (dirty.expanded) persistExpandedState(state);
  dirty.sidebar = dirty.workspace = dirty.expanded = false;
}

function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  const w = typeof window !== "undefined" ? window : null;
  if (w && "requestIdleCallback" in w) {
    w.requestIdleCallback(flushPersist, { timeout: 1000 });
  } else {
    setTimeout(flushPersist, 300);
  }
}

useAppStore.subscribe((state, prev) => {
  if (state._dbFolders !== prev._dbFolders || state._dbDocuments !== prev._dbDocuments) {
    dirty.sidebar = true;
  }
  if (state.openTabs !== prev.openTabs || state.activeDocumentId !== prev.activeDocumentId) {
    dirty.workspace = true;
  }
  if (state.expandedFolderIds !== prev.expandedFolderIds || state.expandedDocIds !== prev.expandedDocIds) {
    dirty.expanded = true;
  }
  if (dirty.sidebar || dirty.workspace || dirty.expanded) schedulePersist();
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
}
