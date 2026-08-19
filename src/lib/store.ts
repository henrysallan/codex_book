import { create } from "zustand";
import {
  Document,
  DocumentMeta,
  Folder,
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
  deleteDocument as dbDeleteDocument,
  deleteFolder as dbDeleteFolder,
  renameFolder as dbRenameFolder,
  moveDocument as dbMoveDocument,
  moveFolder as dbMoveFolder,
  setParentDocument as dbSetParentDocument,
  propagatePageLinkTitle,
  propagateDatabaseRowTitle,
  buildFolderTree,
  getRootDocuments,
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
  syncQuickNoteDatabases,
  syncDailyParentDatabase,
  createMoodboardState as dbCreateMoodboardState,
} from "./db";
import { v4 as uuidv4 } from "uuid";

// ─── LocalStorage Cache Helpers ───

const CACHE_KEYS = {
  DB_FOLDERS: "cortex:cache:dbFolders",
  DB_DOCUMENTS: "cortex:cache:dbDocuments",
  OPEN_TABS: "cortex:cache:openTabs",
  ACTIVE_DOC_ID: "cortex:cache:activeDocumentId",
  EXPANDED_FOLDERS: "cortex:cache:expandedFolderIds",
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
  expandedFolderIds: Set<string>;
}): void {
  cacheWrite(CACHE_KEYS.OPEN_TABS, state.openTabs);
  cacheWrite(CACHE_KEYS.ACTIVE_DOC_ID, state.activeDocumentId);
  cacheWrite(CACHE_KEYS.EXPANDED_FOLDERS, [...state.expandedFolderIds]);
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
  expandedFolderIds: Set<string>;
} | null {
  const openTabs = cacheRead<OpenTab[]>(CACHE_KEYS.OPEN_TABS);
  const activeDocumentId = cacheRead<string | null>(CACHE_KEYS.ACTIVE_DOC_ID);
  const expandedArr = cacheRead<string[]>(CACHE_KEYS.EXPANDED_FOLDERS);
  if (!openTabs) return null;
  return {
    openTabs,
    activeDocumentId: activeDocumentId ?? null,
    expandedFolderIds: new Set(expandedArr ?? []),
  };
}

interface AppState {
  // Data
  folders: Folder[];
  rootDocuments: DocumentMeta[];
  expandedFolderIds: Set<string>;
  openTabs: OpenTab[];
  activeDocumentId: string | null;
  activeDocument: Document | null;
  isChatOpen: boolean;
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

  // Raw db data for rebuilding tree
  _dbFolders: DbFolder[];  
  _dbDocuments: DbDocument[];

  // Actions
  initialize: () => Promise<void>;
  _rebuildTree: () => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  toggleFolder: (folderId: string) => void;
  openDocument: (docId: string) => Promise<void>;
  closeTab: (docId: string) => void;
  setActiveTab: (docId: string) => Promise<void>;
  createFolder: (name: string, parentId?: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createDocument: (folderId?: string | null, docType?: import("./types").DocType) => Promise<string>;
  saveDocument: (
    id: string,
    updates: Partial<{
      title: string;
      subtitle: string | null;
      content: string;
      tags: string[];
      settings: import("./types").NoteSettings;
    }>
  ) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  moveDocument: (docId: string, folderId: string | null) => Promise<void>;
  moveFolder: (folderId: string, parentId: string | null, parentDocumentId?: string | null) => Promise<void>;
  setParentDocument: (docId: string, parentDocId: string | null) => Promise<void>;
  toggleChat: () => void;
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
}

export const useAppStore = create<AppState>((set, get) => ({
  folders: [],
  rootDocuments: [],
  expandedFolderIds: new Set<string>(),
  openTabs: [],
  activeDocumentId: null,
  activeDocument: null,
  isChatOpen: false,
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

  /** Rebuild sidebar tree from in-memory _dbFolders / _dbDocuments and persist cache.
   *  Use this after local mutations instead of initialize() to avoid a full DB re-fetch. */
  _rebuildTree: () => {
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const folders = buildFolderTree(_dbFolders, _dbDocuments, expandedFolderIds);
    const rootDocs = getRootDocuments(_dbDocuments, _dbFolders);
    set({ folders, rootDocuments: rootDocs });
    persistSidebarCache({ _dbFolders, _dbDocuments });
  },

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
      const cached = loadSidebarCache();
      const workspace = loadWorkspaceState();

      if (cached) {
        const expandedIds = workspace?.expandedFolderIds ?? get().expandedFolderIds;
        const folders = buildFolderTree(cached.dbFolders, cached.dbDocuments, expandedIds);
        const rootDocs = getRootDocuments(cached.dbDocuments, cached.dbFolders);

        set({
          _dbFolders: cached.dbFolders,
          _dbDocuments: cached.dbDocuments,
          folders,
          rootDocuments: rootDocs,
          expandedFolderIds: expandedIds,
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

      const expandedIds = get().expandedFolderIds;
      const folders = buildFolderTree(dbFolders, dbDocuments, expandedIds);
      const rootDocs = getRootDocuments(dbDocuments, dbFolders);

      set({
        _dbFolders: dbFolders,
        _dbDocuments: dbDocuments,
        folders,
        rootDocuments: rootDocs,
        isLoading: false,
      });

      // Update the sidebar cache with fresh data
      persistSidebarCache({ _dbFolders: dbFolders, _dbDocuments: dbDocuments });

      // If tabs were restored from cache, validate they still exist
      const { openTabs } = get();
      if (openTabs.length > 0) {
        const docIds = new Set(dbDocuments.map((d) => d.id));
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
    const { expandedFolderIds, _dbFolders, _dbDocuments } = get();
    const newExpanded = new Set(expandedFolderIds);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    const folders = buildFolderTree(_dbFolders, _dbDocuments, newExpanded);
    const rootDocs = getRootDocuments(_dbDocuments, _dbFolders);
    set({
      expandedFolderIds: newExpanded,
      folders,
      rootDocuments: rootDocs,
    });
  },

  openDocument: async (docId: string) => {
    const { openTabs, _isNavigating, navHistory, navIndex } = get();
    const existing = openTabs.find((t) => t.documentId === docId);

    // Push to nav history (unless we're navigating via back/forward)
    if (!_isNavigating) {
      const trimmed = navHistory.slice(0, navIndex + 1);
      set({ navHistory: [...trimmed, docId], navIndex: trimmed.length });
    }

    if (!existing) {
      const dbDoc = await fetchDocument(docId);
      if (!dbDoc) return;

      const doc = dbDocumentToDocument(dbDoc);
      // Cache the document
      const cache = new Map(get()._documentCache);
      cache.set(doc.id, doc);
      set({
        openTabs: [...openTabs, { documentId: doc.id, title: doc.title }],
        activeDocumentId: doc.id,
        activeDocument: doc,
        activeAnnotation: null,
        _documentCache: cache,
      });
      await get().loadAnnotations(doc.id);
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

    // Remove from caches
    const docCache = new Map(get()._documentCache);
    const annCache = new Map(get()._annotationsCache);
    docCache.delete(docId);
    annCache.delete(docId);
    set({ _documentCache: docCache, _annotationsCache: annCache });
  },

  setActiveTab: async (docId: string) => {
    const { _isNavigating, navHistory, navIndex, _documentCache, _annotationsCache } = get();
    // Push to nav history (unless we're navigating via back/forward)
    if (!_isNavigating) {
      const trimmed = navHistory.slice(0, navIndex + 1);
      set({ navHistory: [...trimmed, docId], navIndex: trimmed.length });
    }

    // Instantly swap to cached version if available
    const cached = _documentCache.get(docId);
    const cachedAnnotations = _annotationsCache.get(docId);
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
        const doc = dbDocumentToDocument(dbDoc);
        const cache = new Map(get()._documentCache);
        cache.set(doc.id, doc);
        // Only update if still viewing this doc
        if (get().activeDocumentId === doc.id) {
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
    const doc = dbDocumentToDocument(dbDoc);
    const cache = new Map(get()._documentCache);
    cache.set(doc.id, doc);
    set({ activeDocumentId: doc.id, activeDocument: doc, activeAnnotation: null, _documentCache: cache });
    await get().loadAnnotations(doc.id);
  },

  createFolder: async (name: string, parentId: string | null = null) => {
    // Optimistic: inject folder into local state immediately
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
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const newFolders = [..._dbFolders, tempFolder];
    set({
      _dbFolders: newFolders,
      folders: buildFolderTree(newFolders, _dbDocuments, expandedFolderIds),
    });
    // Persist in background then reconcile with real data
    dbCreateFolder(name, parentId).then((realFolder) => {
      const docs = get()._dbDocuments;
      const folders = get()._dbFolders.map((f) => f.id === tempFolder.id ? realFolder : f);
      set({ _dbFolders: folders });
      get()._rebuildTree();
    }).catch(console.error);
  },

  renameFolder: async (id: string, name: string) => {
    // Optimistic: update in local state immediately
    const { _dbFolders } = get();
    set({ _dbFolders: _dbFolders.map((f) => f.id === id ? { ...f, name, updated_at: new Date().toISOString() } : f) });
    get()._rebuildTree();
    dbRenameFolder(id, name).catch(console.error);
  },

  deleteFolder: async (id: string) => {
    // Optimistic: remove from local state
    const { _dbFolders, _dbDocuments } = get();
    const folderIds = new Set<string>();
    const collect = (fid: string) => {
      folderIds.add(fid);
      _dbFolders.filter((f) => f.parent_id === fid).forEach((f) => collect(f.id));
    };
    collect(id);
    set({
      _dbFolders: _dbFolders.filter((f) => !folderIds.has(f.id)),
      _dbDocuments: _dbDocuments.filter((d) => !d.folder_id || !folderIds.has(d.folder_id)),
    });
    get()._rebuildTree();
    dbDeleteFolder(id).catch(console.error);
  },

  createDocument: async (folderId: string | null = null, docType: import("./types").DocType = "note") => {
    // Optimistic: inject doc into local state immediately
    const now = new Date().toISOString();
    const tempId = uuidv4();
    const tempDoc: DbDocument = {
      id: tempId,
      title: docType === "moodboard" ? "Untitled Moodboard" : "Untitled",
      subtitle: null,
      folder_id: folderId,
      parent_document_id: null,
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
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const newDocs = [..._dbDocuments, tempDoc];
    set({
      _dbDocuments: newDocs,
      folders: buildFolderTree(_dbFolders, newDocs, expandedFolderIds),
      rootDocuments: getRootDocuments(newDocs, _dbFolders),
    });
    // Persist and open — must await so we return the real id
    const title = docType === "moodboard" ? "Untitled Moodboard" : "Untitled";
    const dbDoc = await dbCreateDocument(folderId, title, "[]", null, docType);
    // If it's a moodboard, create the companion moodboard_state row
    if (docType === "moodboard") {
      try {
        await dbCreateMoodboardState(dbDoc.id);
      } catch (err) {
        console.error("Failed to create moodboard state:", err);
      }
    }
    // Reconcile: swap temp doc for the real one
    const reconciledDocs = get()._dbDocuments.map((d) => (d.id === tempId ? dbDoc : d));
    set({
      _dbDocuments: reconciledDocs,
      folders: buildFolderTree(get()._dbFolders, reconciledDocs, get().expandedFolderIds),
      rootDocuments: getRootDocuments(reconciledDocs, get()._dbFolders),
    });
    await get().openDocument(dbDoc.id);
    return dbDoc.id;
  },

  saveDocument: async (id, updates) => {
    await dbUpdateDocument(id, updates);

    // Update active document and cache
    const { activeDocument, openTabs, _documentCache } = get();
    if (activeDocument && activeDocument.id === id) {
      const updated = { ...activeDocument, ...updates };
      const cache = new Map(_documentCache);
      cache.set(id, updated);
      set({ activeDocument: updated, _documentCache: cache });
    } else if (_documentCache.has(id)) {
      const cache = new Map(_documentCache);
      cache.set(id, { ...(_documentCache.get(id) as Document), ...updates });
      set({ _documentCache: cache });
    }

    // Update tab title if title changed
    if (updates.title) {
      set({
        openTabs: openTabs.map((t) =>
          t.documentId === id ? { ...t, title: updates.title! } : t
        ),
      });

      // Propagate the new title to all pageLink nodes referencing this doc
      try {
        await propagatePageLinkTitle(id, updates.title);
      } catch (err) {
        console.error("Failed to propagate page link title:", err);
      }

      // Propagate the new title to any database row that links to this doc
      try {
        await propagateDatabaseRowTitle(id, updates.title);
      } catch (err) {
        console.error("Failed to propagate database row title:", err);
      }

      // Update title in _dbDocuments and rebuild tree (no DB re-fetch)
      const { _dbDocuments: docs } = get();
      set({ _dbDocuments: docs.map((d) => d.id === id ? { ...d, title: updates.title! } : d) });
      get()._rebuildTree();
    }
  },

  deleteDocument: async (id: string) => {
    get().closeTab(id);
    // Optimistic: remove from local state
    const { _dbDocuments: docs } = get();
    set({ _dbDocuments: docs.filter((d) => d.id !== id) });
    get()._rebuildTree();
    dbDeleteDocument(id).catch(console.error);
  },

  moveDocument: async (docId: string, folderId: string | null) => {
    // Optimistic: update folder_id in local state
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const newDocs = _dbDocuments.map((d) =>
      d.id === docId ? { ...d, folder_id: folderId, parent_document_id: null } : d
    );
    set({
      _dbDocuments: newDocs,
      folders: buildFolderTree(_dbFolders, newDocs, expandedFolderIds),
      rootDocuments: getRootDocuments(newDocs, _dbFolders),
    });
    dbMoveDocument(docId, folderId).then(() => {
      // Reconcile: update with server-confirmed data
      get()._rebuildTree();
    }).catch(console.error);
  },

  moveFolder: async (folderId: string, parentId: string | null, parentDocumentId: string | null = null) => {
    // Optimistic: update parent_id / parent_document_id in local state
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const newFolders = _dbFolders.map((f) =>
      f.id === folderId
        ? { ...f, parent_id: parentId, parent_document_id: parentDocumentId }
        : f
    );
    set({
      _dbFolders: newFolders,
      folders: buildFolderTree(newFolders, _dbDocuments, expandedFolderIds),
      rootDocuments: getRootDocuments(_dbDocuments, newFolders),
    });
    dbMoveFolder(folderId, parentId, parentDocumentId).then(() => {
      get()._rebuildTree();
    }).catch(console.error);
  },

  setParentDocument: async (docId: string, parentDocId: string | null) => {
    // Optimistic: update parent_document_id in local state
    const { _dbFolders, _dbDocuments, expandedFolderIds } = get();
    const parentDoc = parentDocId ? _dbDocuments.find((d) => d.id === parentDocId) : null;
    const newDocs = _dbDocuments.map((d) =>
      d.id === docId
        ? {
            ...d,
            parent_document_id: parentDocId,
            folder_id: parentDoc ? parentDoc.folder_id : d.folder_id,
          }
        : d
    );
    set({
      _dbDocuments: newDocs,
      folders: buildFolderTree(_dbFolders, newDocs, expandedFolderIds),
      rootDocuments: getRootDocuments(newDocs, _dbFolders),
    });
    dbSetParentDocument(docId, parentDocId).then(() => {
      get()._rebuildTree();
    }).catch(console.error);
  },

  toggleChat: () =>
    set((s) => ({
      isChatOpen: !s.isChatOpen,
      // Close annotation chat when opening main chat
      activeAnnotation: !s.isChatOpen ? null : s.activeAnnotation,
    })),

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
    try {
      // Run todo + daily in parallel, but sequence quick notes to avoid
      // race condition where multiple parents get created via localStorage
      const [todoDoc, dailyDoc] = await Promise.all([
        ensureTodoDocument(),
        ensureTodayDailyDocument(),
      ]);
      const quickNoteParent = await ensureQuickNoteParentDocument();
      const todayQuickNotes = await fetchTodayQuickNotes();

      // Sync database blocks in Daily Documents parent + Quick Notes parent
      const dailyParentId = dailyDoc.parent_document_id;
      if (dailyParentId) {
        await syncDailyParentDatabase(dailyParentId);
      }
      await syncQuickNoteDatabases(quickNoteParent.id);

      // Parse todo items from the todo document content
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
  },

  addTodo: async (text: string) => {
    const { todoDocId, todoItems } = get();
    if (!todoDocId || !text.trim()) return;

    const blockId = uuidv4();
    const newItem: TodoItem = { blockId, text: text.trim(), checked: false };

    // Optimistic UI update — prepend
    set({ todoItems: [newItem, ...todoItems] });

    // Build the new block and persist
    try {
      const dbDoc = await fetchDocument(todoDocId);
      if (!dbDoc) return;
      const blocks = safeParseBlocks(dbDoc.content);
      const newBlock = makeTodoBlock(blockId, text.trim());
      blocks.unshift(newBlock);
      await dbUpdateDocument(todoDocId, { content: JSON.stringify(blocks) });

      // Update cache
      const cache = new Map(get()._documentCache);
      if (cache.has(todoDocId)) {
        cache.set(todoDocId, { ...cache.get(todoDocId)!, content: JSON.stringify(blocks) });
        set({ _documentCache: cache });
      }
    } catch (err) {
      console.error("Failed to add todo:", err);
    }
  },

  toggleTodo: async (blockId: string) => {
    const { todoDocId, todoItems } = get();
    if (!todoDocId) return;

    // Optimistic UI update
    set({
      todoItems: todoItems.map((t) =>
        t.blockId === blockId ? { ...t, checked: !t.checked } : t
      ),
    });

    try {
      const dbDoc = await fetchDocument(todoDocId);
      if (!dbDoc) return;
      const blocks = safeParseBlocks(dbDoc.content);
      const block = blocks.find((b: Record<string, unknown>) => b.id === blockId);
      if (block && block.props) {
        (block.props as Record<string, unknown>).checked =
          !(block.props as Record<string, unknown>).checked;
      }
      await dbUpdateDocument(todoDocId, { content: JSON.stringify(blocks) });

      // Update cache
      const cache = new Map(get()._documentCache);
      if (cache.has(todoDocId)) {
        cache.set(todoDocId, { ...cache.get(todoDocId)!, content: JSON.stringify(blocks) });
        set({ _documentCache: cache });
      }
    } catch (err) {
      console.error("Failed to toggle todo:", err);
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

// ─── Auto-persist state changes to localStorage ───
// Uses Zustand subscribe to watch for changes without modifying individual actions.

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

useAppStore.subscribe((state, prev) => {
  // Debounce writes to avoid thrashing localStorage on rapid state changes
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    // Persist sidebar hierarchy when folders/documents change
    if (state._dbFolders !== prev._dbFolders || state._dbDocuments !== prev._dbDocuments) {
      persistSidebarCache({
        _dbFolders: state._dbFolders,
        _dbDocuments: state._dbDocuments,
      });
    }

    // Persist workspace state (tabs, active doc, expanded folders)
    if (
      state.openTabs !== prev.openTabs ||
      state.activeDocumentId !== prev.activeDocumentId ||
      state.expandedFolderIds !== prev.expandedFolderIds
    ) {
      persistWorkspaceState({
        openTabs: state.openTabs,
        activeDocumentId: state.activeDocumentId,
        expandedFolderIds: state.expandedFolderIds,
      });
    }
  }, 300);
});
