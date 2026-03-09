import { create } from "zustand";
import {
  Document,
  DocumentMeta,
  Folder,
  OpenTab,
  ChatMessage,
  DbFolder,
  DbDocument,
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
  propagatePageLinkTitle,
  buildFolderTree,
  getRootDocuments,
  dbDocumentToDocument,
} from "./db";

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
  isLoading: boolean;

  // Raw db data for rebuilding tree
  _dbFolders: DbFolder[];
  _dbDocuments: DbDocument[];

  // Actions
  initialize: () => Promise<void>;
  toggleFolder: (folderId: string) => void;
  openDocument: (docId: string) => Promise<void>;
  closeTab: (docId: string) => void;
  setActiveTab: (docId: string) => Promise<void>;
  createFolder: (name: string, parentId?: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createDocument: (folderId?: string | null) => Promise<string>;
  saveDocument: (
    id: string,
    updates: Partial<{
      title: string;
      subtitle: string | null;
      content: string;
      tags: string[];
    }>
  ) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  moveDocument: (docId: string, folderId: string | null) => Promise<void>;
  toggleChat: () => void;
  addChatMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => void;
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
  isLoading: true,
  _dbFolders: [],
  _dbDocuments: [],

  initialize: async () => {
    try {
      const [dbFolders, dbDocuments] = await Promise.all([
        fetchFolders(),
        fetchDocuments(),
      ]);

      const expandedIds = get().expandedFolderIds;
      const folders = buildFolderTree(dbFolders, dbDocuments, expandedIds);
      const rootDocs = getRootDocuments(dbDocuments);

      set({
        _dbFolders: dbFolders,
        _dbDocuments: dbDocuments,
        folders,
        rootDocuments: rootDocs,
        isLoading: false,
      });
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
    const rootDocs = getRootDocuments(_dbDocuments);
    set({
      expandedFolderIds: newExpanded,
      folders,
      rootDocuments: rootDocs,
    });
  },

  openDocument: async (docId: string) => {
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.documentId === docId);

    if (!existing) {
      const dbDoc = await fetchDocument(docId);
      if (!dbDoc) return;

      const doc = dbDocumentToDocument(dbDoc);
      set({
        openTabs: [...openTabs, { documentId: doc.id, title: doc.title }],
        activeDocumentId: doc.id,
        activeDocument: doc,
      });
    } else {
      await get().setActiveTab(docId);
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
  },

  setActiveTab: async (docId: string) => {
    const dbDoc = await fetchDocument(docId);
    if (!dbDoc) return;
    const doc = dbDocumentToDocument(dbDoc);
    set({ activeDocumentId: doc.id, activeDocument: doc });
  },

  createFolder: async (name: string, parentId: string | null = null) => {
    await dbCreateFolder(name, parentId);
    await get().initialize();
  },

  renameFolder: async (id: string, name: string) => {
    await dbRenameFolder(id, name);
    await get().initialize();
  },

  deleteFolder: async (id: string) => {
    await dbDeleteFolder(id);
    await get().initialize();
  },

  createDocument: async (folderId: string | null = null) => {
    const dbDoc = await dbCreateDocument(folderId);
    await get().initialize();
    await get().openDocument(dbDoc.id);
    return dbDoc.id;
  },

  saveDocument: async (id, updates) => {
    await dbUpdateDocument(id, updates);

    // Update active document if it's the one being saved
    const { activeDocument, openTabs } = get();
    if (activeDocument && activeDocument.id === id) {
      set({
        activeDocument: { ...activeDocument, ...updates },
      });
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
    }

    // Refresh tree
    await get().initialize();
  },

  deleteDocument: async (id: string) => {
    get().closeTab(id);
    await dbDeleteDocument(id);
    await get().initialize();
  },

  moveDocument: async (docId: string, folderId: string | null) => {
    await dbMoveDocument(docId, folderId);
    await get().initialize();
  },

  toggleChat: () => set((s) => ({ isChatOpen: !s.isChatOpen })),

  addChatMessage: (msg) => {
    const message: ChatMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, message] }));
  },
}));
