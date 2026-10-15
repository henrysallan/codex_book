import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

import { fetchTree, type TreeData } from "./api";

const EXPANDED_KEY = "cortex.expanded.v1";
const OPEN_DOC_KEY = "cortex.openDoc.v1";

type State = {
  tree: TreeData | null;
  treeLoading: boolean;
  treeError: string | null;
  expandedFolderIds: ReadonlySet<string>;
  expandedDocIds: ReadonlySet<string>;

  /** The one note shown in the Notes tab. */
  openDocId: string | null;
  /** Notes reached by following page links, for the Notes tab back button. */
  backStack: string[];

  loadTree: () => Promise<void>;
  toggleExpanded: (kind: "folder" | "doc", id: string) => void;
  /** Open from the tree: replaces the note and clears link history. */
  openNote: (id: string) => void;
  /** Follow a page link: the current note goes on the back stack. */
  followLink: (id: string) => void;
  goBack: () => void;
  /** Keep the tree's copy of a row current after a save elsewhere in the app. */
  patchDocMeta: (
    id: string,
    patch: { updated_at?: string; title?: string },
  ) => void;
  hydrate: () => Promise<void>;
  reset: () => void;
};

function persistExpanded(
  folders: ReadonlySet<string>,
  docs: ReadonlySet<string>,
) {
  AsyncStorage.setItem(
    EXPANDED_KEY,
    JSON.stringify({ folders: [...folders], docs: [...docs] }),
  ).catch(() => {});
}

function persistOpenDoc(id: string | null) {
  (id
    ? AsyncStorage.setItem(OPEN_DOC_KEY, id)
    : AsyncStorage.removeItem(OPEN_DOC_KEY)
  ).catch(() => {});
}

export const useAppStore = create<State>((set, get) => ({
  tree: null,
  treeLoading: false,
  treeError: null,
  expandedFolderIds: new Set(),
  expandedDocIds: new Set(),
  openDocId: null,
  backStack: [],

  loadTree: async () => {
    set({ treeLoading: true, treeError: null });
    try {
      const tree = await fetchTree();
      set({ tree, treeLoading: false });
    } catch (err) {
      set({
        treeLoading: false,
        treeError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  toggleExpanded: (kind, id) => {
    const { expandedFolderIds, expandedDocIds } = get();
    const target = new Set(
      kind === "folder" ? expandedFolderIds : expandedDocIds,
    );
    if (target.has(id)) target.delete(id);
    else target.add(id);
    const next =
      kind === "folder"
        ? { expandedFolderIds: target, expandedDocIds }
        : { expandedFolderIds, expandedDocIds: target };
    set(next);
    persistExpanded(next.expandedFolderIds, next.expandedDocIds);
  },

  openNote: (id) => {
    set({ openDocId: id, backStack: [] });
    persistOpenDoc(id);
  },

  followLink: (id) => {
    const { openDocId, backStack } = get();
    if (id === openDocId) return;
    set({
      openDocId: id,
      backStack: openDocId ? [...backStack, openDocId] : backStack,
    });
    persistOpenDoc(id);
  },

  goBack: () => {
    const { backStack } = get();
    const prev = backStack[backStack.length - 1];
    if (!prev) return;
    set({ openDocId: prev, backStack: backStack.slice(0, -1) });
    persistOpenDoc(prev);
  },

  patchDocMeta: (id, patch) => {
    const { tree } = get();
    if (!tree) return;
    set({
      tree: {
        ...tree,
        documents: tree.documents.map((d) =>
          d.id === id ? { ...d, ...patch } : d,
        ),
      },
    });
  },

  hydrate: async () => {
    try {
      const [expanded, openDoc] = await Promise.all([
        AsyncStorage.getItem(EXPANDED_KEY),
        AsyncStorage.getItem(OPEN_DOC_KEY),
      ]);
      const parsed = expanded
        ? (JSON.parse(expanded) as { folders?: string[]; docs?: string[] })
        : {};
      set({
        expandedFolderIds: new Set(parsed.folders ?? []),
        expandedDocIds: new Set(parsed.docs ?? []),
        openDocId: openDoc,
      });
    } catch {
      // Cosmetic state only; start collapsed.
    }
  },

  reset: () => {
    set({ tree: null, openDocId: null, backStack: [] });
    persistOpenDoc(null);
  },
}));
