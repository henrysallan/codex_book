"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  CornerUpLeft,
  FilePlus,
  FileText,
  FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { DocType } from "@/lib/types";
import {
  ROOT_KEY,
  PINNED_DOC_TYPES,
  ancestorKeys,
  buildTreeIndex,
  countDescendantDocs,
  createChildSorter,
  docKey,
  flattenTree,
  folderKey,
  parseKey,
  subtreeEnd,
  type NodeKey,
  type SortDir,
  type SortMode,
  type TreeIndex,
  type TreeRow,
} from "@/lib/fileTree";
import { Modal } from "@/components/Modal";

// ─── Layout constants ───

/** Every row is exactly this tall, which is what makes windowing trivial. */
const ROW_H = 28;
const INDENT = 14;
const BASE_PAD = 6;
/** Rows rendered beyond the viewport, and the granularity of window updates. */
const OVERSCAN = 10;
const CHUNK = 8;
const DRAG_THRESHOLD = 5;
const SPRING_OPEN_MS = 550;
const HOVER_PREFETCH_MS = 150;
const AUTOSCROLL_EDGE = 36;
const FLASH_MS = 900;
const ENTER_HOLD_UPDATES = 3;

const DRAFT_KEY = "draft";
const EMPTY: ReadonlySet<NodeKey> = new Set();

type ViewRow = TreeRow | (Omit<TreeRow, "kind"> & { kind: "draft" });

type DropState = "target" | "region" | null;

interface DragState {
  keys: NodeKey[];
  label: string;
  kind: "folder" | "doc";
  docType?: DocType;
}

interface MenuState {
  x: number;
  y: number;
  /** Items the menu acts on (empty = the blank area of the tree). */
  keys: NodeKey[];
}

export interface FileTreeHandle {
  /** Show an inline "new folder" row inside `parentFolderId` (or the current root). */
  startNewFolder: (parentFolderId: string | null) => void;
}

interface FileTreeProps {
  /** Show only this folder's contents (sidebar "focus" mode). */
  rootFolderId: string | null;
  sortMode: SortMode;
  sortDir: SortDir;
  onEnterFolder: (folderId: string) => void;
}

const rowDomId = (key: NodeKey) => `ft-${key}`;

function labelFor(index: TreeIndex, key: NodeKey): string {
  const p = parseKey(key);
  if (!p) return "";
  if (p.kind === "folder") return index.folders.get(p.id)?.name ?? "";
  return index.docs.get(p.id)?.title || "Untitled";
}

function DocIcon({ docType, className }: { docType: DocType | undefined; className?: string }) {
  if (docType === "todo") return <CheckSquare size={14} className={className} />;
  if (docType === "daily_parent" || docType === "daily") return <CalendarDays size={14} className={className} />;
  if (docType === "quick_note_parent") return <Zap size={14} className={className} />;
  if (docType === "moodboard") return <LayoutGrid size={14} className={className} />;
  return <FileText size={14} className={className} />;
}

export const FileTree = memo(forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { rootFolderId, sortMode, sortDir, onEnterFolder },
  ref
) {
  const dbFolders = useAppStore((s) => s._dbFolders);
  const dbDocuments = useAppStore((s) => s._dbDocuments);
  const expandedFolderIds = useAppStore((s) => s.expandedFolderIds);
  const expandedDocIds = useAppStore((s) => s.expandedDocIds);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);

  const rootKey = rootFolderId ? folderKey(rootFolderId) : ROOT_KEY;

  // ─── Derived tree ───

  const index = useMemo(() => buildTreeIndex(dbFolders, dbDocuments), [dbFolders, dbDocuments]);
  const sortedChildren = useMemo(
    () => createChildSorter(index, sortMode, sortDir),
    [index, sortMode, sortDir]
  );
  const baseRows = useMemo(
    () => flattenTree(index, sortedChildren, { rootKey, expandedFolderIds, expandedDocIds }),
    [index, sortedChildren, rootKey, expandedFolderIds, expandedDocIds]
  );

  // ─── Interaction state ───

  const [rawSelection, setSelection] = useState<ReadonlySet<NodeKey>>(EMPTY);
  const [cursor, setCursor] = useState<NodeKey | null>(null);
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const [renaming, setRenaming] = useState<NodeKey | null>(null);
  const [draft, setDraft] = useState<{ parentKey: NodeKey } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NodeKey[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropKey, setDropKey] = useState<NodeKey | null>(null);
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<NodeKey>>(EMPTY);
  const anchorRef = useRef<NodeKey | null>(null);
  /** A row to scroll into view once it has been laid out. */
  const revealRef = useRef<NodeKey | null>(null);

  const rows: ViewRow[] = useMemo(() => {
    if (!draft) return baseRows;
    const atRoot = draft.parentKey === rootKey;
    const parentIdx = atRoot ? -1 : baseRows.findIndex((r) => r.key === draft.parentKey);
    if (!atRoot && parentIdx < 0) return baseRows;
    const out: ViewRow[] = baseRows.slice();
    out.splice(parentIdx + 1, 0, {
      key: DRAFT_KEY,
      kind: "draft",
      id: "",
      depth: atRoot ? 0 : baseRows[parentIdx].depth + 1,
      parentKey: draft.parentKey,
      hasChildren: false,
      expanded: false,
    });
    return out;
  }, [baseRows, draft, rootKey]);

  const keyToIndex = useMemo(() => {
    const m = new Map<NodeKey, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);

  // Rows that just appeared (created, moved in, revealed by expanding) fade in.
  // Derived from the previous row list during render (React's "adjust state on
  // prop change" pattern), so it never lags a frame behind.
  // Keys stay "entering" for a few row updates, so a data update right after
  // an insert (e.g. the server reconciling a new row) doesn't cut the fade short.
  const [enterState, setEnterState] = useState<{
    rows: ViewRow[];
    gen: number;
    keys: ReadonlyMap<NodeKey, number>;
  }>(() => ({ rows, gen: 0, keys: new Map() }));
  let entering = enterState.keys;
  if (enterState.rows !== rows) {
    const gen = enterState.gen + 1;
    const prev = new Set(enterState.rows.map((r) => r.key));
    const next = new Map<NodeKey, number>();
    for (const [k, at] of enterState.keys) if (gen - at < ENTER_HOLD_UPDATES) next.set(k, at);
    for (const r of rows) if (!prev.has(r.key)) next.set(r.key, gen);
    entering = next;
    setEnterState({ rows, gen, keys: next });
  }

  // Drop feedback: the target row, plus a tint over its visible subtree.
  const dropRegion = useMemo(() => {
    if (!dropKey || dropKey === rootKey) return null;
    const i = keyToIndex.get(dropKey);
    if (i === undefined) return null;
    return { start: i, end: subtreeEnd(rows as TreeRow[], i) };
  }, [dropKey, rootKey, keyToIndex, rows]);

  // Selection only ever acts on rows that are currently visible.
  const selection = useMemo(() => {
    if (rawSelection.size === 0) return rawSelection;
    const live = [...rawSelection].filter((k) => keyToIndex.has(k));
    return live.length === rawSelection.size ? rawSelection : new Set(live);
  }, [rawSelection, keyToIndex]);

  // Latest render values for event handlers, which stay referentially stable.
  const stateRef = useRef({ rows, keyToIndex, index, selection, cursor, rootKey, renaming, drag });
  useLayoutEffect(() => {
    stateRef.current = { rows, keyToIndex, index, selection, cursor, rootKey, renaming, drag };
  });

  // ─── Virtual window ───

  const scrollRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ start: 0, end: 60 });

  const updateWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = Math.floor(el.scrollTop / ROW_H);
    const visible = Math.ceil(el.clientHeight / ROW_H);
    const start = Math.max(0, Math.floor(first / CHUNK) * CHUNK - OVERSCAN);
    const end = Math.ceil((first + visible) / CHUNK) * CHUNK + OVERSCAN;
    setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateWindow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateWindow]);

  // Each root (top level / a focused folder) keeps its own scroll position;
  // any change in length may also clamp scrollTop, so re-measure the window.
  const scrollMemoRef = useRef(new Map<NodeKey, number>());
  const lastRootRef = useRef(rootKey);
  useLayoutEffect(() => {
    if (lastRootRef.current !== rootKey) {
      lastRootRef.current = rootKey;
      revealRef.current = null;
      if (scrollRef.current) scrollRef.current.scrollTop = scrollMemoRef.current.get(rootKey) ?? 0;
    }
    updateWindow();
  }, [rootKey, rows.length, updateWindow]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) scrollMemoRef.current.set(stateRef.current.rootKey, el.scrollTop);
    updateWindow();
  }, [updateWindow]);

  const scrollRowIntoView = useCallback((i: number, mode: "nearest" | "center" = "nearest") => {
    const el = scrollRef.current;
    if (!el) return;
    const top = i * ROW_H;
    const bottom = top + ROW_H;
    if (top >= el.scrollTop && bottom <= el.scrollTop + el.clientHeight) return;
    el.scrollTop =
      mode === "center"
        ? Math.max(0, top - el.clientHeight / 3)
        : top < el.scrollTop
        ? top
        : bottom - el.clientHeight;
  }, []);

  const focusTree = useCallback(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // ─── Expansion ───

  const setExpanded = useCallback((key: NodeKey, expanded: boolean) => {
    const p = parseKey(key);
    if (!p) return;
    useAppStore
      .getState()
      .setTreeExpanded(p.kind === "folder" ? { folderIds: [p.id] } : { docIds: [p.id] }, expanded);
  }, []);

  const toggleExpanded = useCallback((key: NodeKey) => {
    const p = parseKey(key);
    if (!p) return;
    const s = useAppStore.getState();
    if (p.kind === "folder") s.toggleFolder(p.id);
    else s.toggleDocExpanded(p.id);
  }, []);

  // ─── Reveal the active document (expand its ancestors, scroll to it) ───

  const lastRevealedRef = useRef<string | null>(null);
  const expandedFolderIdsRef = useRef(expandedFolderIds);
  const expandedDocIdsRef = useRef(expandedDocIds);
  useLayoutEffect(() => {
    expandedFolderIdsRef.current = expandedFolderIds;
    expandedDocIdsRef.current = expandedDocIds;
  });

  useEffect(() => {
    if (!activeDocumentId || activeDocumentId.startsWith("drive:")) return;
    if (lastRevealedRef.current === activeDocumentId) return;
    if (!index.docs.has(activeDocumentId)) return;
    lastRevealedRef.current = activeDocumentId;
    const key = docKey(activeDocumentId);
    const ancestors = ancestorKeys(index, key);
    let chain = ancestors;
    if (rootKey !== ROOT_KEY) {
      const at = ancestors.indexOf(rootKey);
      if (at < 0) return; // outside the focused folder
      chain = ancestors.slice(0, at);
    }
    const folderIds: string[] = [];
    const docIds: string[] = [];
    for (const k of chain) {
      const p = parseKey(k);
      if (p?.kind === "folder") folderIds.push(p.id);
      else if (p) docIds.push(p.id);
    }
    useAppStore.getState().setTreeExpanded({ folderIds, docIds }, true);
    setCursor(key);
    // Already laid out (nothing had to expand): scroll now. Otherwise scroll
    // once the expanded rows render.
    const i = stateRef.current.keyToIndex.get(key);
    if (i !== undefined && folderIds.every((id) => expandedFolderIdsRef.current.has(id)) && docIds.every((id) => expandedDocIdsRef.current.has(id))) {
      revealRef.current = null;
      scrollRowIntoView(i, "center");
    } else {
      revealRef.current = key;
    }
  }, [activeDocumentId, index, rootKey, scrollRowIntoView]);

  useLayoutEffect(() => {
    const key = revealRef.current;
    if (!key) return;
    const i = keyToIndex.get(key);
    if (i === undefined) return;
    revealRef.current = null;
    scrollRowIntoView(i, "center");
  }, [keyToIndex, scrollRowIntoView]);

  // ─── Actions ───

  const flash = useCallback((keys: NodeKey[]) => {
    setFlashKeys(new Set(keys));
    window.setTimeout(() => setFlashKeys(EMPTY), FLASH_MS);
  }, []);

  const activate = useCallback(
    (key: NodeKey) => {
      const p = parseKey(key);
      if (!p) return;
      if (p.kind === "doc") void useAppStore.getState().openDocument(p.id);
      else toggleExpanded(key);
    },
    [toggleExpanded]
  );

  const createInside = useCallback((key: NodeKey) => {
    const p = parseKey(key);
    const s = useAppStore.getState();
    if (!p) {
      // The blank area means "here": the current root, not the open page's folder.
      const root = parseKey(stateRef.current.rootKey);
      void s.createDocument(root?.id ?? null, "note", { exactFolder: true });
    } else if (p.kind === "folder") {
      void s.createDocument(p.id);
    } else {
      void s.createDocument(null, "note", { parentDocumentId: p.id });
    }
  }, []);

  const startNewFolder = useCallback(
    (parentFolderId: string | null) => {
      const parentKey = parentFolderId ? folderKey(parentFolderId) : stateRef.current.rootKey;
      if (parentFolderId) setExpanded(folderKey(parentFolderId), true);
      setMenu(null);
      setRenaming(null);
      setDraft({ parentKey });
      // Scroll the draft row into view once it is laid out.
      requestAnimationFrame(() => {
        const i = stateRef.current.keyToIndex.get(DRAFT_KEY);
        if (i !== undefined) scrollRowIntoView(i);
      });
    },
    [setExpanded, scrollRowIntoView]
  );

  useImperativeHandle(ref, () => ({ startNewFolder }), [startNewFolder]);

  const commitDraft = useCallback(
    (name: string) => {
      const parentKey = draft?.parentKey ?? ROOT_KEY;
      setDraft(null);
      const trimmed = name.trim();
      if (!trimmed) {
        focusTree();
        return;
      }
      const parent = parseKey(parentKey);
      const id = useAppStore
        .getState()
        .createFolder(trimmed, parent?.kind === "folder" ? parent.id : null);
      const key = folderKey(id);
      setCursor(key);
      anchorRef.current = key;
      flash([key]);
      revealRef.current = key;
      focusTree();
    },
    [draft, flash, focusTree]
  );

  const cancelDraft = useCallback(() => {
    setDraft(null);
    focusTree();
  }, [focusTree]);

  const commitRename = useCallback(
    (key: NodeKey, value: string) => {
      setRenaming(null);
      focusTree();
      const name = value.trim();
      const p = parseKey(key);
      if (!p || !name || name === labelFor(stateRef.current.index, key)) return;
      const s = useAppStore.getState();
      if (p.kind === "folder") void s.renameFolder(p.id, name);
      else void s.saveDocument(p.id, { title: name }).catch((err) => console.error("Rename failed:", err));
      // A new name can re-sort the row; follow it.
      revealRef.current = key;
      flash([key]);
    },
    [flash, focusTree]
  );

  const cancelRename = useCallback(() => {
    setRenaming(null);
    focusTree();
  }, [focusTree]);

  /** Selection in display order, or just `key` when it isn't part of a multi-selection. */
  const targetsFor = useCallback((key: NodeKey): NodeKey[] => {
    const { selection, keyToIndex } = stateRef.current;
    if (selection.size > 1 && selection.has(key)) {
      return [...selection].sort((a, b) => (keyToIndex.get(a) ?? 0) - (keyToIndex.get(b) ?? 0));
    }
    return [key];
  }, []);

  const requestDelete = useCallback((keys: NodeKey[]) => {
    const { index } = stateRef.current;
    const deletable = keys.filter((k) => {
      const p = parseKey(k);
      if (!p) return false;
      if (p.kind === "doc") {
        const d = index.docs.get(p.id);
        return !!d && !PINNED_DOC_TYPES.has(d.doc_type);
      }
      return index.folders.has(p.id);
    });
    if (deletable.length) setPendingDelete(deletable);
  }, []);

  const confirmDelete = useCallback(() => {
    const keys = pendingDelete ?? [];
    setPendingDelete(null);
    setSelection(EMPTY);
    // Park the cursor on the nearest surviving row, below the deleted ones if possible.
    const { rows, keyToIndex } = stateRef.current;
    const doomed = new Set(keys);
    let last = -1;
    let first = rows.length;
    for (const k of keys) {
      const i = keyToIndex.get(k);
      if (i === undefined) continue;
      first = Math.min(first, i);
      last = Math.max(last, subtreeEnd(rows as TreeRow[], i) - 1);
    }
    const after = rows.slice(last + 1).find((r) => r.kind !== "draft" && !doomed.has(r.key));
    const before = rows
      .slice(0, first)
      .reverse()
      .find((r) => r.kind !== "draft" && !doomed.has(r.key));
    const next = after ?? before;
    if (next) {
      setCursor(next.key);
      anchorRef.current = next.key;
    }
    const s = useAppStore.getState();
    for (const k of keys) {
      const p = parseKey(k);
      if (!p) continue;
      if (p.kind === "doc") void s.deleteDocument(p.id);
      else void s.deleteFolder(p.id);
    }
  }, [pendingDelete]);

  const closeDelete = useCallback(() => setPendingDelete(null), []);

  const addToContext = useCallback((keys: NodeKey[]) => {
    const s = useAppStore.getState();
    const { index } = stateRef.current;
    for (const k of keys) {
      const p = parseKey(k);
      if (!p) continue;
      const title = labelFor(index, k);
      if (p.kind === "doc") s.addContextItem({ type: "document", docId: p.id, title });
      else s.addContextItem({ type: "folder", folderId: p.id, title });
    }
    if (!s.isChatOpen) s.toggleChat();
  }, []);

  /**
   * Move `keys` into `container` (root, a folder, or a document as sub-pages).
   * Every move applies its optimistic update synchronously, so they all land in
   * one frame and share one undo step.
   */
  const moveInto = useCallback(
    async (keys: NodeKey[], container: NodeKey) => {
      const s = useAppStore.getState();
      const target = parseKey(container);
      await s.runUndoable(async () => {
        const moves: Promise<void>[] = [];
        for (const key of keys) {
          const p = parseKey(key);
          if (!p || key === container) continue;
          if (p.kind === "folder") {
            if (!target) moves.push(s.moveFolder(p.id, null, null));
            else if (target.kind === "folder") moves.push(s.moveFolder(p.id, target.id, null));
            else moves.push(s.moveFolder(p.id, null, target.id));
          } else {
            if (!target) moves.push(s.moveDocument(p.id, null));
            else if (target.kind === "folder") moves.push(s.moveDocument(p.id, target.id));
            else moves.push(s.setParentDocument(p.id, target.id));
          }
        }
        await Promise.all(moves);
      });
    },
    []
  );

  // ─── Pointer: click, selection, hover prefetch ───

  const suppressClickRef = useRef(false);
  const hoverRef = useRef<{ key: NodeKey; timer: number } | null>(null);

  const rowKeyFrom = (target: EventTarget | null): NodeKey | null => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-row]");
    return el?.dataset.key ?? null;
  };
  const actionFrom = (target: EventTarget | null): string | null =>
    (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-action]")?.dataset.action ?? null;

  const selectRange = useCallback((from: NodeKey, to: NodeKey) => {
    const { rows, keyToIndex } = stateRef.current;
    const a = keyToIndex.get(from);
    const b = keyToIndex.get(to);
    if (a === undefined || b === undefined) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    setSelection(new Set(rows.slice(lo, hi + 1).filter((r) => r.kind !== "draft").map((r) => r.key)));
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const key = rowKeyFrom(e.target);
      if (!key) {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) setSelection(EMPTY);
        return;
      }
      if (key === DRAFT_KEY || key === stateRef.current.renaming) return;
      const action = actionFrom(e.target);
      if (action === "toggle") {
        toggleExpanded(key);
        setCursor(key);
        return;
      }
      if (action === "new") {
        createInside(key);
        return;
      }
      if (action === "menu") {
        const btn = (e.target as HTMLElement).closest("[data-action]")!.getBoundingClientRect();
        setMenu({ x: btn.left, y: btn.bottom + 4, keys: targetsFor(key) });
        return;
      }

      if (e.metaKey || e.ctrlKey) {
        setSelection((prev) => {
          // Like Finder: the row you last clicked joins the selection too.
          const next = new Set(prev.size === 0 && anchorRef.current ? [anchorRef.current] : prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        anchorRef.current = key;
        setCursor(key);
        return;
      }
      if (e.shiftKey && anchorRef.current) {
        selectRange(anchorRef.current, key);
        setCursor(key);
        return;
      }
      setSelection(EMPTY);
      anchorRef.current = key;
      setCursor(key);
      activate(key);
    },
    [activate, createInside, selectRange, targetsFor, toggleExpanded]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const key = rowKeyFrom(e.target);
      if (!key || actionFrom(e.target) || key === stateRef.current.renaming) return;
      const p = parseKey(key);
      if (p?.kind === "folder") onEnterFolder(p.id);
    },
    [onEnterFolder]
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const key = rowKeyFrom(e.target);
      if (key === DRAFT_KEY) return;
      if (key && !stateRef.current.selection.has(key)) {
        setSelection(EMPTY);
        anchorRef.current = key;
      }
      if (key) setCursor(key);
      setMenu({ x: e.clientX, y: e.clientY, keys: key ? targetsFor(key) : [] });
    },
    [targetsFor]
  );

  const onPointerOver = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const key = rowKeyFrom(e.target);
    if (hoverRef.current?.key === key) return;
    if (hoverRef.current) window.clearTimeout(hoverRef.current.timer);
    hoverRef.current = null;
    if (!key || !key.startsWith("doc:") || stateRef.current.drag) return;
    const id = key.slice(4);
    hoverRef.current = {
      key,
      timer: window.setTimeout(() => useAppStore.getState().prefetchDocument(id), HOVER_PREFETCH_MS),
    };
  }, []);

  const onPointerLeave = useCallback(() => {
    if (hoverRef.current) window.clearTimeout(hoverRef.current.timer);
    hoverRef.current = null;
  }, []);

  // ─── Drag and drop (pointer-driven; the target is computed from row geometry) ───

  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    key: NodeKey;
    started: boolean;
    keys: NodeKey[];
    x: number;
    y: number;
    target: NodeKey | null;
    spring: { key: NodeKey; timer: number } | null;
    raf: number;
  } | null>(null);

  const computeTarget = useCallback((x: number, y: number, keys: NodeKey[]): NodeKey | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const { rows, index, rootKey } = stateRef.current;
    const yc = y - rect.top + el.scrollTop;
    const i = Math.floor(yc / ROW_H);
    let container: NodeKey;
    if (i < 0 || i >= rows.length) {
      container = rootKey;
    } else {
      const row = rows[i];
      if (row.kind === "draft") return null;
      if (row.kind === "folder") {
        container = row.key;
      } else {
        // Middle of a page row nests under it; its edges mean "next to it".
        const frac = (yc - i * ROW_H) / ROW_H;
        container = frac > 0.25 && frac < 0.75 ? row.key : row.parentKey;
      }
    }
    // Never into itself or its own subtree.
    if (keys.includes(container)) return null;
    if (container !== ROOT_KEY) {
      const up = ancestorKeys(index, container);
      if (keys.some((k) => up.includes(k))) return null;
    }
    return container;
  }, []);

  const updateDragTarget = useCallback(() => {
    const d = dragRef.current;
    if (!d?.started) return;
    const target = computeTarget(d.x, d.y, d.keys);
    if (target !== d.target) {
      d.target = target;
      setDropKey(target);
      // Spring-loaded folders: hovering a collapsed container opens it.
      if (d.spring) window.clearTimeout(d.spring.timer);
      d.spring = null;
      if (target && target !== stateRef.current.rootKey) {
        const i = stateRef.current.keyToIndex.get(target);
        const row = i !== undefined ? stateRef.current.rows[i] : null;
        if (row && !row.expanded && (row.kind === "folder" || row.hasChildren)) {
          d.spring = {
            key: target,
            timer: window.setTimeout(() => {
              if (dragRef.current?.target === target) setExpanded(target, true);
            }, SPRING_OPEN_MS),
          };
        }
      }
    }
  }, [computeTarget, setExpanded]);

  /** Scrolls while the pointer is near the top / bottom edge during a drag. */
  const autoScrollTick = useCallback(() => {
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d?.started || !el) return;
    const rect = el.getBoundingClientRect();
    let dy = 0;
    if (d.x >= rect.left && d.x <= rect.right) {
      if (d.y < rect.top + AUTOSCROLL_EDGE) dy = -Math.ceil((rect.top + AUTOSCROLL_EDGE - d.y) / 3);
      else if (d.y > rect.bottom - AUTOSCROLL_EDGE) dy = Math.ceil((d.y - (rect.bottom - AUTOSCROLL_EDGE)) / 3);
    }
    if (dy) {
      el.scrollTop += Math.max(-24, Math.min(24, dy));
      updateDragTarget();
    }
  }, [updateDragTarget]);

  const startAutoScroll = useCallback(() => {
    const loop = () => {
      const d = dragRef.current;
      if (!d?.started) return;
      autoScrollTick();
      d.raf = requestAnimationFrame(loop);
    };
    const d = dragRef.current;
    if (d) d.raf = requestAnimationFrame(loop);
  }, [autoScrollTick]);

  const endDrag = useCallback((commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.spring) window.clearTimeout(d.spring.timer);
    cancelAnimationFrame(d.raf);
    document.documentElement.classList.remove("ft-dragging");
    if (!d.started) return;
    suppressClickRef.current = true;
    window.setTimeout(() => (suppressClickRef.current = false), 0);
    setDrag(null);
    setDropKey(null);
    if (!commit || !d.target) return;
    const target = d.target;
    const keys = d.keys;
    setSelection(EMPTY);
    // Moves apply optimistically, so confirm where things went right away: the
    // moved rows when they stay in view, otherwise the (collapsed) container.
    const { rows, keyToIndex, rootKey } = stateRef.current;
    const ti = keyToIndex.get(target);
    const landsInView = target === rootKey || (ti !== undefined && rows[ti].expanded);
    flash(landsInView ? keys : [target]);
    void moveInto(keys, target);
  }, [flash, moveInto]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.started = true;
        const { selection, index } = stateRef.current;
        if (!selection.has(d.key)) setSelection(EMPTY);
        d.keys = targetsFor(d.key);
        const first = parseKey(d.keys[0])!;
        setDrag({
          keys: d.keys,
          label: labelFor(index, d.keys[0]),
          kind: first.kind,
          docType: first.kind === "doc" ? index.docs.get(first.id)?.doc_type : undefined,
        });
        setMenu(null);
        document.documentElement.classList.add("ft-dragging");
        startAutoScroll();
      }
      if (overlayRef.current) {
        overlayRef.current.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 6}px, 0)`;
      }
      updateDragTarget();
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current && e.pointerId === dragRef.current.pointerId) endDrag(true);
    };
    const onCancel = () => endDrag(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current?.started) {
        e.preventDefault();
        endDrag(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [startAutoScroll, endDrag, targetsFor, updateDragTarget]);

  // Position the overlay before it paints.
  useLayoutEffect(() => {
    const d = dragRef.current;
    if (drag && d && overlayRef.current) {
      overlayRef.current.style.transform = `translate3d(${d.x + 12}px, ${d.y + 6}px, 0)`;
    }
  }, [drag]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    setKeyboardMode(false);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, button")) return;
    const key = rowKeyFrom(target);
    if (!key || key === DRAFT_KEY || key === stateRef.current.renaming) return;
    // A click is ~100ms away: start loading the page now.
    if (key.startsWith("doc:")) useAppStore.getState().prefetchDocument(key.slice(4));
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      key,
      started: false,
      keys: [key],
      x: e.clientX,
      y: e.clientY,
      target: null,
      spring: null,
      raf: 0,
    };
  }, []);

  // ─── Keyboard ───

  const typeaheadRef = useRef({ text: "", at: 0 });
  const prefetchTimerRef = useRef(0);

  const moveCursor = useCallback(
    (i: number, extend: boolean) => {
      const { rows } = stateRef.current;
      if (rows.length === 0) return;
      const clamped = Math.max(0, Math.min(rows.length - 1, i));
      const key = rows[clamped].key;
      if (key === DRAFT_KEY) return;
      setCursor(key);
      if (extend) {
        if (!anchorRef.current) anchorRef.current = stateRef.current.cursor ?? key;
        selectRange(anchorRef.current, key);
      } else {
        anchorRef.current = key;
      }
      scrollRowIntoView(clamped);
      window.clearTimeout(prefetchTimerRef.current);
      if (key.startsWith("doc:")) {
        const id = key.slice(4);
        prefetchTimerRef.current = window.setTimeout(
          () => useAppStore.getState().prefetchDocument(id),
          250
        );
      }
    },
    [scrollRowIntoView, selectRange]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const { rows, keyToIndex, cursor, selection } = stateRef.current;
      setKeyboardMode(true);
      const ci = cursor !== null ? keyToIndex.get(cursor) ?? -1 : -1;
      const row = ci >= 0 ? rows[ci] : null;
      const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
      const mod = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveCursor(ci < 0 ? 0 : ci + 1, e.shiftKey);
          return;
        case "ArrowUp":
          e.preventDefault();
          moveCursor(ci < 0 ? 0 : ci - 1, e.shiftKey);
          return;
        case "Home":
          e.preventDefault();
          moveCursor(0, e.shiftKey);
          return;
        case "End":
          e.preventDefault();
          moveCursor(rows.length - 1, e.shiftKey);
          return;
        case "PageDown":
          e.preventDefault();
          moveCursor(ci + page, e.shiftKey);
          return;
        case "PageUp":
          e.preventDefault();
          moveCursor(Math.max(0, ci - page), e.shiftKey);
          return;
        case "ArrowRight":
          e.preventDefault();
          if (!row || row.kind === "draft") return;
          if ((row.kind === "folder" || row.hasChildren) && !row.expanded) setExpanded(row.key, true);
          else if (row.expanded && row.hasChildren) moveCursor(ci + 1, false);
          return;
        case "ArrowLeft": {
          e.preventDefault();
          if (!row || row.kind === "draft") return;
          if (row.expanded) {
            setExpanded(row.key, false);
          } else {
            const pi = keyToIndex.get(row.parentKey);
            if (pi !== undefined) moveCursor(pi, false);
          }
          return;
        }
        case "Enter":
        case " ":
          e.preventDefault();
          if (!row || row.kind === "draft") return;
          if (mod && row.kind === "folder") onEnterFolder(row.id);
          else activate(row.key);
          return;
        case "ContextMenu":
        case "F10": {
          if (e.key === "F10" && !e.shiftKey) break;
          e.preventDefault();
          if (!row || row.kind === "draft") return;
          const el = document.getElementById(rowDomId(row.key))?.getBoundingClientRect();
          if (el) setMenu({ x: el.left + 24, y: el.bottom, keys: targetsFor(row.key) });
          return;
        }
        case "F2":
          e.preventDefault();
          if (row && row.kind !== "draft") setRenaming(row.key);
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (selection.size > 0) requestDelete(targetsFor([...selection][0]));
          else if (row && row.kind !== "draft") requestDelete([row.key]);
          return;
        case "Escape":
          if (selection.size > 0) {
            e.preventDefault();
            setSelection(EMPTY);
          }
          return;
        case "a":
          if (mod) {
            e.preventDefault();
            setSelection(new Set(rows.filter((r) => r.kind !== "draft").map((r) => r.key)));
            return;
          }
          break;
      }

      // Type-ahead: jump to the next row whose name starts with what was typed.
      if (e.key.length === 1 && !mod && !e.altKey && /\S/.test(e.key)) {
        const now = Date.now();
        const ta = typeaheadRef.current;
        ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
        ta.at = now;
        const { index } = stateRef.current;
        const n = rows.length;
        const startAt = ta.text.length > 1 ? Math.max(ci, 0) : ci + 1;
        for (let step = 0; step < n; step++) {
          const j = (startAt + step) % n;
          if (rows[j].kind === "draft") continue;
          if (labelFor(index, rows[j].key).toLowerCase().startsWith(ta.text)) {
            moveCursor(j, false);
            break;
          }
        }
      }
    },
    [activate, moveCursor, onEnterFolder, requestDelete, setExpanded, targetsFor]
  );

  const onFocus = useCallback(() => {
    setHasFocus(true);
    const { cursor, rows, keyToIndex } = stateRef.current;
    if (cursor !== null && keyToIndex.has(cursor)) return;
    // Start keyboard navigation from the open page when it's in view.
    const active = useAppStore.getState().activeDocumentId;
    const start = active && keyToIndex.has(docKey(active)) ? docKey(active) : rows[0]?.key;
    if (start) setCursor(start);
  }, []);

  const onBlur = useCallback((e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false);
  }, []);

  // ─── Render ───

  const visible: number[] = [];
  const end = Math.min(rows.length, win.end);
  for (let i = win.start; i < end; i++) visible.push(i);
  // Keep the keyboard cursor and any open name input mounted when scrolled away.
  const pinned = new Set<number>();
  for (const k of [cursor, renaming, draft ? DRAFT_KEY : null]) {
    const i = k ? keyToIndex.get(k) : undefined;
    if (i !== undefined && (i < win.start || i >= end)) pinned.add(i);
  }
  visible.push(...pinned);

  const activeKey = activeDocumentId ? docKey(activeDocumentId) : null;
  const dragging = drag !== null;
  const dragSources = useMemo(() => new Set(drag?.keys ?? []), [drag]);
  const rootIsDropTarget = dragging && dropKey === rootKey;

  return (
    <>
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        aria-activedescendant={cursor && keyToIndex.has(cursor) ? rowDomId(cursor) : undefined}
        tabIndex={0}
        className={`ft-tree relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none rounded-md transition-colors ${
          rootIsDropTarget ? "bg-ink/[0.04] ring-1 ring-inset ring-ink/25" : ""
        } ${dragging ? "ft-tree-dragging" : ""}`}
        onScroll={onScroll}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerOver={onPointerOver}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {/* Re-keyed per root so entering a folder swaps rows instead of sliding them. */}
        <div key={rootKey} className="relative" style={{ height: rows.length * ROW_H + ROW_H }}>
          {visible.map((i) => {
            const row = rows[i];
            if (row.kind === "draft") {
              return (
                <DraftFolderRow
                  key={DRAFT_KEY}
                  index={i}
                  depth={row.depth}
                  onCommit={commitDraft}
                  onCancel={cancelDraft}
                />
              );
            }
            const doc = row.kind === "doc" ? index.docs.get(row.id) : undefined;
            return (
              <TreeRowView
                key={row.key}
                rowKey={row.key}
                kind={row.kind}
                index={i}
                depth={row.depth}
                hasChildren={row.hasChildren}
                expanded={row.expanded}
                label={labelFor(index, row.key)}
                docType={doc?.doc_type}
                isActive={row.key === activeKey}
                isSelected={selection.has(row.key)}
                isCursor={keyboardMode && hasFocus && row.key === cursor}
                isRenaming={row.key === renaming}
                isDragSource={dragging && dragSources.has(row.key)}
                drop={
                  dragging && dropRegion && i >= dropRegion.start && i < dropRegion.end
                    ? i === dropRegion.start
                      ? "target"
                      : "region"
                    : null
                }
                entering={entering.has(row.key)}
                flashing={flashKeys.has(row.key)}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
              />
            );
          })}
        </div>
        {rows.length === 0 && !draft && (
          <p className="absolute inset-x-0 top-2 px-4 text-xs text-muted-foreground select-none">
            {rootKey === ROOT_KEY ? "No pages yet." : "This folder is empty."}
          </p>
        )}
      </div>

      {drag &&
        createPortal(
          <div
            ref={overlayRef}
            className="fixed left-0 top-0 z-[9999] pointer-events-none flex items-center gap-1.5 max-w-[240px] px-2 py-1 rounded-md bg-surface shadow-lg border border-border text-xs text-foreground"
            style={{ willChange: "transform" }}
          >
            {drag.kind === "folder" ? (
              <FolderIcon size={13} className="text-muted-foreground shrink-0" />
            ) : (
              <DocIcon docType={drag.docType} className="text-muted-foreground shrink-0" />
            )}
            <span className="truncate">{drag.label}</span>
            {drag.keys.length > 1 && (
              <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-foreground text-background text-[10px] font-medium leading-none">
                {drag.keys.length}
              </span>
            )}
          </div>,
          document.body
        )}

      {menu && (
        <TreeContextMenu
          menu={menu}
          index={index}
          rootKey={rootKey}
          onClose={() => {
            setMenu(null);
            focusTree();
          }}
          onRename={(key) => setRenaming(key)}
          onDelete={requestDelete}
          onNewPage={createInside}
          onNewFolder={startNewFolder}
          onAddToContext={addToContext}
          onFocusFolder={onEnterFolder}
          onMoveToRoot={(keys) => void moveInto(keys, ROOT_KEY)}
        />
      )}

      {pendingDelete && (
        <DeleteDialog keys={pendingDelete} index={index} onCancel={closeDelete} onConfirm={confirmDelete} />
      )}
    </>
  );
}));

/* ---------- Row ---------- */

interface TreeRowViewProps {
  rowKey: NodeKey;
  kind: "folder" | "doc";
  index: number;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  label: string;
  docType: DocType | undefined;
  isActive: boolean;
  isSelected: boolean;
  isCursor: boolean;
  isRenaming: boolean;
  isDragSource: boolean;
  drop: DropState;
  entering: boolean;
  flashing: boolean;
  onRenameCommit: (key: NodeKey, value: string) => void;
  onRenameCancel: () => void;
}

/** One tree row. Props are primitives so React.memo skips every row that didn't change. */
const TreeRowView = memo(function TreeRowView({
  rowKey,
  kind,
  index,
  depth,
  hasChildren,
  expanded,
  label,
  docType,
  isActive,
  isSelected,
  isCursor,
  isRenaming,
  isDragSource,
  drop,
  entering,
  flashing,
  onRenameCommit,
  onRenameCancel,
}: TreeRowViewProps) {
  const isFolder = kind === "folder";
  const expandable = isFolder || hasChildren;
  const isSystem = !isFolder && !!docType && PINNED_DOC_TYPES.has(docType);

  const tone = isSelected
      ? "bg-blue-500/15 dark:bg-blue-500/25"
      : isActive
      ? "bg-ink/[0.07] text-foreground"
      : "hover:bg-ink/[0.04]";

  return (
    <div
      id={rowDomId(rowKey)}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected || isActive}
      aria-expanded={expandable ? expanded : undefined}
      data-row=""
      data-key={rowKey}
      data-enter={entering ? "" : undefined}
      data-drop={drop ?? undefined}
      className="ft-row group absolute inset-x-0 top-0 px-1"
      style={{ height: ROW_H, transform: `translate3d(0, ${index * ROW_H}px, 0)` }}
    >
      <div
        className={`ft-row-inner relative flex h-full items-center gap-1 rounded-md pr-1 text-[13px] leading-none select-none cursor-default ${tone} ${
          isDragSource ? "opacity-40" : ""
        } ${isCursor ? "ring-1 ring-inset ring-ink/30" : ""} ${flashing ? "ft-flash" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
      >
        {depth > 0 &&
          Array.from({ length: depth }, (_, d) => (
            <span
              key={d}
              aria-hidden
              className="ft-guide absolute top-0 bottom-0 w-px bg-ink/10"
              style={{ left: BASE_PAD + d * INDENT + 7 }}
            />
          ))}
        <span
          data-action={expandable ? "toggle" : undefined}
          className={`relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center rounded text-muted-foreground ${
            expandable ? "hover:bg-ink/10 hover:text-foreground" : ""
          }`}
        >
          {expandable && (
            <ChevronRight
              size={12}
              className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </span>
        <span className={`shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
          {isFolder ? (
            expanded ? <FolderOpen size={14} /> : <FolderIcon size={14} />
          ) : (
            <DocIcon docType={docType} />
          )}
        </span>
        {isRenaming ? (
          <RenameInput
            initial={label}
            onCommit={(v) => onRenameCommit(rowKey, v)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span title={label} className={`ml-0.5 flex-1 truncate ${isActive ? "font-medium" : ""}`}>
            {label}
          </span>
        )}
        {!isRenaming && (
          <span className="ft-row-actions hidden shrink-0 items-center gap-0.5 group-hover:flex">
            {!isSystem && (
              <button
                type="button"
                tabIndex={-1}
                data-action="new"
                title={isFolder ? "New page in folder" : "New sub-page"}
                aria-label={isFolder ? "New page in folder" : "New sub-page"}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-ink/10 hover:text-foreground"
              >
                <Plus size={13} />
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              data-action="menu"
              title="More actions"
              aria-label="More actions"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-ink/10 hover:text-foreground"
            >
              <MoreHorizontal size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
});

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={inputRef}
      value={value}
      aria-label="Name"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="ml-0.5 min-w-0 flex-1 h-[22px] rounded border border-ink/25 bg-background px-1.5 text-[13px] text-foreground outline-none focus:border-ink/40"
    />
  );
}

function DraftFolderRow({
  index,
  depth,
  onCommit,
  onCancel,
}: {
  index: number;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-row=""
      data-key={DRAFT_KEY}
      data-enter=""
      className="ft-row absolute inset-x-0 top-0 px-1"
      style={{ height: ROW_H, transform: `translate3d(0, ${index * ROW_H}px, 0)` }}
    >
      <div
        className="flex h-full items-center gap-1 rounded-md bg-ink/[0.04] pr-1"
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
      >
        <span className="w-4 shrink-0" />
        <FolderIcon size={14} className="shrink-0 text-muted-foreground" />
        <DraftInput onCommit={onCommit} onCancel={onCancel} />
      </div>
    </div>
  );
}

function DraftInput({ onCommit, onCancel }: { onCommit: (name: string) => void; onCancel: () => void }) {
  return (
    <RenameInput
      initial=""
      onCommit={(v) => (v.trim() ? onCommit(v) : onCancel())}
      onCancel={onCancel}
    />
  );
}

/* ---------- Context menu ---------- */

type MenuItem =
  | { kind: "item"; label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean; hint?: string }
  | { kind: "sep" };

function TreeContextMenu({
  menu,
  index,
  rootKey,
  onClose,
  onRename,
  onDelete,
  onNewPage,
  onNewFolder,
  onAddToContext,
  onFocusFolder,
  onMoveToRoot,
}: {
  menu: MenuState;
  index: TreeIndex;
  rootKey: NodeKey;
  onClose: () => void;
  onRename: (key: NodeKey) => void;
  onDelete: (keys: NodeKey[]) => void;
  onNewPage: (key: NodeKey) => void;
  onNewFolder: (parentFolderId: string | null) => void;
  onAddToContext: (keys: NodeKey[]) => void;
  onFocusFolder: (folderId: string) => void;
  onMoveToRoot: (keys: NodeKey[]) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y, ready: false });
  /** Highlighted item (keyboard / hover); -1 until the user moves. */
  const [active, setActive] = useState(-1);

  const keys = menu.keys;
  const single = keys.length === 1 ? parseKey(keys[0]) : null;
  const isRootLevel = (k: NodeKey) => index.parent.get(k) === ROOT_KEY;
  const isSystemDoc =
    single?.kind === "doc" && PINNED_DOC_TYPES.has(index.docs.get(single.id)?.doc_type ?? "note");

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const items: MenuItem[] = [];
  if (keys.length === 0) {
    const rootFolder = parseKey(rootKey);
    items.push(
      { kind: "item", label: "New page", icon: <FilePlus size={13} />, onSelect: run(() => onNewPage(rootKey)) },
      {
        kind: "item",
        label: "New folder",
        icon: <FolderPlus size={13} />,
        onSelect: run(() => onNewFolder(rootFolder?.id ?? null)),
      }
    );
  } else if (single?.kind === "folder") {
    items.push(
      { kind: "item", label: "New page", icon: <FilePlus size={13} />, onSelect: run(() => onNewPage(keys[0])) },
      { kind: "item", label: "New folder", icon: <FolderPlus size={13} />, onSelect: run(() => onNewFolder(single.id)) },
      { kind: "sep" },
      { kind: "item", label: "Rename", hint: "F2", icon: <Pencil size={13} />, onSelect: run(() => onRename(keys[0])) },
      { kind: "item", label: "Open as root", hint: "⌘↵", icon: <FolderInput size={13} />, onSelect: run(() => onFocusFolder(single.id)) },
      { kind: "item", label: "Add to chat context", icon: <MessageSquarePlus size={13} />, onSelect: run(() => onAddToContext(keys)) }
    );
  } else if (single?.kind === "doc") {
    if (!isSystemDoc) {
      items.push(
        { kind: "item", label: "New sub-page", icon: <FilePlus size={13} />, onSelect: run(() => onNewPage(keys[0])) },
        { kind: "sep" },
        { kind: "item", label: "Rename", hint: "F2", icon: <Pencil size={13} />, onSelect: run(() => onRename(keys[0])) }
      );
    }
    items.push({
      kind: "item",
      label: "Add to chat context",
      icon: <MessageSquarePlus size={13} />,
      onSelect: run(() => onAddToContext(keys)),
    });
  } else {
    items.push({
      kind: "item",
      label: `Add ${keys.length} to chat context`,
      icon: <MessageSquarePlus size={13} />,
      onSelect: run(() => onAddToContext(keys)),
    });
  }
  if (keys.length > 0 && keys.some((k) => !isRootLevel(k)) && !isSystemDoc) {
    items.push({
      kind: "item",
      label: "Move to top level",
      icon: <CornerUpLeft size={13} />,
      onSelect: run(() => onMoveToRoot(keys)),
    });
  }
  if (keys.length > 0 && !isSystemDoc) {
    items.push(
      { kind: "sep" },
      {
        kind: "item",
        label: keys.length > 1 ? `Delete ${keys.length} items` : "Delete",
        hint: "⌫",
        danger: true,
        icon: <Trash2 size={13} />,
        onSelect: run(() => onDelete(keys)),
      }
    );
  }
  const actionable = items
    .map((it, i) => (it.kind === "item" ? i : -1))
    .filter((i) => i >= 0);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8));
    const top = menu.y + r.height + 8 > window.innerHeight ? Math.max(8, menu.y - r.height) : menu.y;
    setPos({ left, top, ready: true });
  }, [menu.x, menu.y]);

  // Take focus once visible (a visibility:hidden element can't be focused), so
  // arrow keys drive the menu rather than the tree behind it.
  useLayoutEffect(() => {
    if (pos.ready) panelRef.current?.focus({ preventScroll: true });
  }, [pos.ready]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onAway = () => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    document.addEventListener("scroll", onAway, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
      document.removeEventListener("scroll", onAway, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      className="fixed z-[9999] min-w-[200px] rounded-lg border border-border bg-surface p-1 shadow-xl outline-none ft-menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const at = actionable.indexOf(active);
          const n = actionable.length;
          const next =
            at < 0
              ? e.key === "ArrowDown" ? 0 : n - 1
              : e.key === "ArrowDown" ? (at + 1) % n : (at - 1 + n) % n;
          setActive(actionable[next]);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const it = items[active];
          if (it?.kind === "item") it.onSelect();
        }
      }}
    >
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onPointerEnter={() => setActive(i)}
            onClick={it.onSelect}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              it.danger ? "text-red-600 dark:text-red-400" : "text-foreground"
            } ${
              i === active
                ? it.danger
                  ? "bg-red-50 dark:bg-red-500/10"
                  : "bg-ink/[0.06]"
                : ""
            }`}
          >
            <span className="shrink-0 opacity-80">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-[10px] text-muted-foreground">{it.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
}

/* ---------- Delete confirmation ---------- */

function DeleteDialog({
  keys,
  index,
  onCancel,
  onConfirm,
}: {
  keys: NodeKey[];
  index: TreeIndex;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const docs = keys.filter((k) => k.startsWith("doc:"));
  const folders = keys.filter((k) => k.startsWith("folder:"));
  const subPages = docs.reduce((n, k) => n + countDescendantDocs(index, k), 0);
  const single = keys.length === 1;
  const noun = single ? (folders.length ? "folder" : "page") : `${keys.length} items`;

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={`Delete ${noun}`}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 ft-fade-in"
      panelClassName="bg-surface rounded-xl shadow-xl w-[380px] overflow-hidden ft-pop-in"
    >
      <div className="px-5 pt-5 pb-3 flex items-start gap-3">
        <div className="p-2 rounded-full bg-red-50 text-red-500 dark:bg-red-500/15 dark:text-red-400 shrink-0 mt-0.5">
          <AlertTriangle size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Delete {noun}?</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {single ? (
              <>
                <strong className="text-foreground break-words">{labelFor(index, keys[0])}</strong> will be
                permanently deleted.
              </>
            ) : (
              <>
                {docs.length > 0 && `${docs.length} page${docs.length === 1 ? "" : "s"}`}
                {docs.length > 0 && folders.length > 0 && " and "}
                {folders.length > 0 && `${folders.length} folder${folders.length === 1 ? "" : "s"}`} will be
                permanently deleted.
              </>
            )}
            {subPages > 0 &&
              ` This includes ${subPages} sub-page${subPages === 1 ? "" : "s"}.`}
            {folders.length > 0 &&
              " Pages inside deleted folders move to the top level; subfolders are kept."}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg text-foreground hover:bg-ink/5 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          data-autofocus
          onClick={onConfirm}
          className="px-3 py-1.5 text-xs rounded-lg text-white bg-red-500 hover:bg-red-600 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
