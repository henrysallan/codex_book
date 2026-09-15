"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useAppStore, isNewerTimestamp } from "@/lib/store";
import { Document, Annotation, NoteSettings } from "@/lib/types";
import { parseBacklinks, syncBacklinks, createDocument as dbCreateDocument, keepalivePatchDocument, StaleWriteError, dbDocumentToDocument } from "@/lib/db";
import { schema } from "@/lib/editorSchema";
import { useCreateBlockNote, useBlockNoteEditor } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  DefaultReactSuggestionItem,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  DragHandleMenu,
  SideMenu,
  SideMenuController,
  RemoveBlockItem,
  BlockColorsItem,
  useComponentsContext,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  useSelectedBlocks,
} from "@blocknote/react";
import { filterSuggestionItems, SideMenuExtension } from "@blocknote/core/extensions";
import { combineByGroup } from "@blocknote/core";
import * as locales from "@blocknote/core/locales";
import { useExtensionState } from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import {
  getMultiColumnSlashMenuItems,
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import { X, FileText, FilePlus, MessageSquarePlus, MessageSquare, Trash2, Table2, Plus } from "lucide-react";
import { AnnotationChat } from "@/components/AnnotationChat";
import { NoteSettingsButton } from "@/components/NoteSettingsButton";

import { authedFetch } from "@/lib/apiFetch";
type SyncStatus = "synced" | "pending" | "saving" | "conflict" | "error";

type RemoteDocument = {
  content: string;
  updatedAt: string;
  title: string;
  subtitle: string | null;
};

// ─── Own-write memory ───
//
// `documents.updated_at` moves on every update, including the indexer's
// bookkeeping writes, so a timestamp mismatch alone does not mean someone else
// edited the note. We remember (hashes of) every content string this client has
// loaded, sent, or adopted per document; a server row whose content is one of
// ours is never a conflict. Module-level so an editor remounted right after a
// document switch still recognises a flush the previous instance sent.

const OWN_WRITE_LIMIT = 8;
const ownWritesByDoc = new Map<string, string[]>();

function hashContent(s: string): string {
  // Two independent FNV-1a style 32-bit hashes; plenty for "is this string one
  // of the handful we wrote" and much cheaper than keeping the strings around.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x0100019b) ^ (h2 >>> 13);
  }
  return `${s.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

function rememberOwnWrite(docId: string, content: string): void {
  const h = hashContent(content);
  const list = ownWritesByDoc.get(docId) ?? [];
  if (list.includes(h)) return;
  list.push(h);
  if (list.length > OWN_WRITE_LIMIT) list.shift();
  ownWritesByDoc.set(docId, list);
}

function isOwnWrite(docId: string, content: string): boolean {
  return ownWritesByDoc.get(docId)?.includes(hashContent(content)) ?? false;
}

/** A save that has not resolved in this long no longer blocks the next one. */
const SAVE_STALL_MS = 20_000;
let saveTokenCounter = 0;

interface DocumentEditorProps {
  document: Document;
}

// ─── Custom drag handle menu item: "Add to context" ───

function AddToContextItem({
  children,
  docTitle,
}: {
  children: React.ReactNode;
  docTitle: string;
}) {
  const Components = useComponentsContext()!;
  const addContextItem = useAppStore((s) => s.addContextItem);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = useExtensionState(SideMenuExtension as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selector: (state: any) => state?.block,
  });

  if (!block) return null;

  const handleClick = () => {
    let text = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = block as any;
    if (Array.isArray(b.content)) {
      text = b.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => (typeof item === "string" ? item : item.text || ""))
        .join("");
    }
    if (!text) text = b.type || "Block";

    addContextItem({
      type: "block",
      blockId: b.id,
      text: text.length > 60 ? text.slice(0, 60) + "…" : text,
      docTitle,
    });
  };

  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={handleClick}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

// ─── Custom drag handle menu item: "Annotation Chat" ───

function AnnotateChatItem({
  children,
  documentId,
}: {
  children: React.ReactNode;
  documentId: string;
}) {
  const Components = useComponentsContext()!;
  const openAnnotationChat = useAppStore((s) => s.openAnnotationChat);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = useExtensionState(SideMenuExtension as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selector: (state: any) => state?.block,
  });

  if (!block) return null;

  const handleClick = () => {
    let text = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = block as any;
    if (Array.isArray(b.content)) {
      text = b.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => (typeof item === "string" ? item : item.text || ""))
        .join("");
    }
    if (!text) text = b.type || "Block";
    openAnnotationChat(documentId, b.id, text);
  };

  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={handleClick}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

// ─── Custom formatting toolbar button: "Annotate" ───

function AnnotateToolbarButton({ documentId }: { documentId: string }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const openAnnotationChat = useAppStore((s) => s.openAnnotationChat);

  const blocks = useSelectedBlocks();
  // Only show when inline content blocks are selected
  if (blocks.filter((block) => block.content !== undefined).length === 0) {
    return null;
  }

  const handleClick = () => {
    // Get the selected text
    const selection = editor.getSelection();
    if (!selection) return;

    let selectedText = "";
    for (const block of selection.blocks) {
      if (Array.isArray(block.content)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of block.content as any[]) {
          if (typeof item === "string") selectedText += item;
          else if (item.text) selectedText += item.text;
        }
        selectedText += "\n";
      }
    }
    selectedText = selectedText.trim();
    if (!selectedText) return;

    // Apply faint yellow highlight to the selected text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (editor as any).addStyles({ backgroundColor: "yellow" });

    // Open annotation chat
    const blockId = selection.blocks[0]?.id ?? null;
    openAnnotationChat(documentId, blockId, selectedText);
  };

  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Annotation Chat"
      label="Annotation Chat"
      onClick={handleClick}
      icon={<MessageSquare size={16} />}
    />
  );
}

// ─── Annotation markers on blocks with existing annotations ───

function AnnotationMarkers({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const documentAnnotations = useAppStore((s) => s.documentAnnotations);
  const activeAnnotation = useAppStore((s) => s.activeAnnotation);
  const openExistingAnnotation = useAppStore(
    (s) => s.openExistingAnnotation
  );
  const deleteAnnotationById = useAppStore((s) => s.deleteAnnotationById);
  const [markers, setMarkers] = useState<
    { id: string; top: number; annotation: Annotation }[]
  >([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    annotationId: string;
  } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [contextMenu]);

  const calcPositions = useCallback(() => {
    const container = containerRef.current;
    if (!container || documentAnnotations.length === 0) {
      setMarkers([]);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const newMarkers: { id: string; top: number; annotation: Annotation }[] =
      [];
    for (const ann of documentAnnotations) {
      if (!ann.blockId) continue;
      const blockEl = container.querySelector(
        `[data-id="${ann.blockId}"]`
      );
      if (blockEl) {
        const blockRect = blockEl.getBoundingClientRect();
        newMarkers.push({
          id: ann.id,
          top: blockRect.top - containerRect.top + 4,
          annotation: ann,
        });
      }
    }
    setMarkers(newMarkers);
  }, [documentAnnotations, containerRef]);

  // Recalculate on annotation list change
  useEffect(() => {
    requestAnimationFrame(calcPositions);
  }, [calcPositions]);

  // Observe DOM mutations (block moves, additions, deletions) to update positions
  useEffect(() => {
    const container = containerRef.current;
    if (!container || documentAnnotations.length === 0) return;

    const observer = new MutationObserver(() => {
      requestAnimationFrame(calcPositions);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-id", "style", "class"],
    });
    return () => observer.disconnect();
  }, [containerRef, documentAnnotations, calcPositions]);

  return (
    <>
      {markers.map((m) =>
        m.id === activeAnnotation?.id ? null : (
          <button
            key={m.id}
            className="absolute right-4 z-10 w-6 h-6 rounded-full bg-yellow-100 border border-yellow-300 flex items-center justify-center hover:bg-yellow-200 transition-colors"
            style={{ top: m.top }}
            title={`"${m.annotation.highlightedText.slice(0, 40)}${m.annotation.highlightedText.length > 40 ? "…" : ""}"`}
            onClick={() => openExistingAnnotation(m.annotation)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, annotationId: m.id });
            }}
          >
            <MessageSquare size={10} className="text-yellow-600" />
          </button>
        )
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white rounded-lg border border-border shadow-lg py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x - 150 }}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
            onClick={() => {
              deleteAnnotationById(contextMenu.annotationId);
              setContextMenu(null);
            }}
          >
            <Trash2 size={12} />
            Delete annotation
          </button>
        </div>
      )}
    </>
  );
}

// ─── Floating annotation chat positioned next to annotated block ───

function FloatingAnnotationChat({
  containerRef,
  blockId,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  blockId: string | null;
}) {
  const [topOffset, setTopOffset] = useState<number | null>(null);

  const calcPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container || !blockId) return;
    const blockEl = container.querySelector(`[data-id="${blockId}"]`);
    if (blockEl) {
      const containerRect = container.getBoundingClientRect();
      const blockRect = blockEl.getBoundingClientRect();
      setTopOffset(blockRect.top - containerRect.top);
    }
  }, [blockId, containerRef]);

  useEffect(() => {
    requestAnimationFrame(calcPosition);
  }, [calcPosition]);

  // Observe DOM mutations so chat follows block when it moves
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !blockId) return;

    const observer = new MutationObserver(() => {
      requestAnimationFrame(calcPosition);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-id", "style", "class"],
    });
    return () => observer.disconnect();
  }, [containerRef, blockId, calcPosition]);

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (topOffset !== null) {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [topOffset]);

  if (topOffset === null) return null;

  return (
    <div
      className="absolute right-4 z-20 origin-top"
      style={{
        top: topOffset,
        opacity: visible ? 1 : 0,
        transform: visible ? 'scaleY(1)' : 'scaleY(0.92)',
        transition: 'opacity 0.3s ease-out, transform 0.3s ease-out',
      }}
    >
      <AnnotationChat />
    </div>
  );
}

export function DocumentEditor({ document }: DocumentEditorProps) {
  const saveDocument = useAppStore((s) => s.saveDocument);
  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const [title, setTitle] = useState(document.title);
  const [subtitle, setSubtitle] = useState(document.subtitle || "");
  const [tags, setTags] = useState<string[]>(document.tags || []);
  const [tagInput, setTagInput] = useState("");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;
  /** True while we are replacing blocks ourselves, so onChange must not autosave. */
  const seedingRef = useRef(false);
  /** The server row this editor last loaded, saved, or adopted. */
  const baseUpdatedAtRef = useRef(document.updatedAt);
  const baseContentRef = useRef(document.content);
  /** The save currently in flight, if any, and whether another was requested meanwhile. */
  const saveRunRef = useRef<{ token: number; startedAt: number } | null>(null);
  const queuedSaveRef = useRef<{ flush: boolean } | null>(null);
  const persistRef = useRef<(opts?: { flush?: boolean }) => Promise<void>>(async () => {});
  /** A foreign version of this document that a save collided with. */
  const [conflict, setConflict] = useState<RemoteDocument | null>(null);
  const conflictRef = useRef<RemoteDocument | null>(null);
  const titleRef = useRef(title);
  const subtitleRef = useRef(subtitle);
  titleRef.current = title;
  subtitleRef.current = subtitle;
  const [lastSavedAt, setLastSavedAt] = useState(() =>
    document.updatedAt ? new Date(document.updatedAt).getTime() : Date.now()
  );
  const [now, setNow] = useState(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const loadAnnotations = useAppStore((s) => s.loadAnnotations);
  const [noteSettings, setNoteSettings] = useState<NoteSettings>(document.settings ?? {});

  // Index-only documents: read-only, no block selection/editing
  const isIndexDoc = document.docType === "daily_parent" || document.docType === "quick_note_parent";

  // Inline entry input for todo and quick_note_parent
  const hasEntryInput = document.docType === "todo" || document.docType === "quick_note_parent";
  const addTodo = useAppStore((s) => s.addTodo);
  const addQuickNote = useAppStore((s) => s.addQuickNote);
  const [entryInput, setEntryInput] = useState("");
  const entryInputRef = useRef<HTMLInputElement>(null);

  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<NoteSettings | null>(null);

  const handleSettingsChange = useCallback(
    (newSettings: NoteSettings) => {
      setNoteSettings(newSettings);
      pendingSettings.current = newSettings;
      if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
      settingsSaveTimer.current = setTimeout(() => {
        const next = pendingSettings.current;
        pendingSettings.current = null;
        settingsSaveTimer.current = null;
        if (next) saveDocument(document.id, { settings: next });
      }, 400);
    },
    [document.id, saveDocument]
  );

  useEffect(() => {
    return () => {
      if (settingsSaveTimer.current) {
        clearTimeout(settingsSaveTimer.current);
        const next = pendingSettings.current;
        if (next) saveDocument(document.id, { settings: next });
      }
    };
  }, [document.id, saveDocument]);

  // Load annotations for this document
  useEffect(() => {
    loadAnnotations(document.id);
  }, [document.id, loadAnnotations]);

  const initialContent = useMemo(() => {
    try {
      const parsed = JSON.parse(document.content);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through
    }
    return undefined;
    // Only parse at mount for this document; autosave must not rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id]);

  const editor = useCreateBlockNote({
    schema,
    initialContent,
    dropCursor: multiColumnDropCursor,
    dictionary: {
      ...locales.en,
      multi_column: multiColumnLocales.en,
    },
    domAttributes: {
      editor: {
        style: "padding-inline:0;padding-left:0;padding-right:0",
      },
    },
  });

  // ─── Custom slash menu items (defaults + "New page" + document links) ───

  const getSlashMenuItems = useCallback(
    (query: string): DefaultReactSuggestionItem[] => {
      // Default items (headings, lists, code, etc.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const defaultItems = getDefaultReactSlashMenuItems(editor as any);

      // "New page" — create a document and insert a page-link to it
      const newPageItem: DefaultReactSuggestionItem = {
        title: "New page",
        onItemClick: async () => {
          // Create silently (no navigation)
          const dbDoc = await dbCreateDocument(null);
          // Add to local state and rebuild tree (no DB re-fetch)
          const { _dbDocuments } = useAppStore.getState();
          const newDoc = { ...dbDoc, content: "[]", settings: {} };
          useAppStore.setState({ _dbDocuments: [..._dbDocuments, newDoc] });
          useAppStore.getState()._rebuildTree();
          editor.insertInlineContent([
            {
              type: "pageLink" as const,
              props: { docId: dbDoc.id, docTitle: "Untitled" },
            },
            " ",
          ]);
        },
        aliases: ["new", "create", "page", "subpage"],
        group: "Pages",
        icon: <FilePlus size={18} />,
        subtext: "Create a new page and insert a link",
      };

      // Each existing document as a linkable slash-menu item
      const docItems: DefaultReactSuggestionItem[] = _dbDocuments
        .filter((d) => d.id !== document.id)
        .map((doc) => ({
          title: doc.title || "Untitled",
          onItemClick: () => {
            editor.insertInlineContent([
              {
                type: "pageLink" as const,
                props: {
                  docId: doc.id,
                  docTitle: doc.title || "Untitled",
                },
              },
              " ",
            ]);
          },
          aliases: ["link", "page", "link to page"],
          group: "Pages",
          icon: <FileText size={18} />,
        }));

      // "Database" — insert an inline database table
      const insertDatabaseItem: DefaultReactSuggestionItem = {
        title: "Database",
        subtext: "Insert an inline database table",
        onItemClick: async () => {
          const defaultCol = {
            id: crypto.randomUUID(),
            name: "Name",
            type: "text",
            width: 200,
            isTitle: true,
          };
          // Create a linked document for the first row
          const rowDoc = await dbCreateDocument(null, "Untitled");
          const defaultRow = {
            id: crypto.randomUUID(),
            docId: rowDoc.id,
            cells: { [defaultCol.id]: "Untitled" },
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (editor as any).insertBlocks(
            [
              {
                type: "database",
                props: {
                  columns: JSON.stringify([defaultCol]),
                  rows: JSON.stringify([defaultRow]),
                },
              },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (editor as any).getTextCursorPosition().block,
            "after"
          );
          // Add to local state and rebuild tree (no DB re-fetch)
          const { _dbDocuments: docs2 } = useAppStore.getState();
          const newRowDoc = { ...rowDoc, content: "[]", settings: {} };
          useAppStore.setState({ _dbDocuments: [...docs2, newRowDoc] });
          useAppStore.getState()._rebuildTree();
        },
        aliases: ["database", "table", "db", "spreadsheet"],
        group: "Advanced",
        icon: <Table2 size={18} />,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const multiColumnItems = getMultiColumnSlashMenuItems(editor as any);

      return filterSuggestionItems(
        combineByGroup(
          [...defaultItems, insertDatabaseItem, newPageItem, ...docItems],
          multiColumnItems
        ),
        query
      );
    },
    [editor, _dbDocuments, document.id]
  );

  // ─── @ mention menu (page links) ───

  const getPageMentionItems = useCallback(
    (query: string): DefaultReactSuggestionItem[] => {
      const items: DefaultReactSuggestionItem[] = _dbDocuments
        .filter((d) => d.id !== document.id)
        .map((doc) => ({
          title: doc.title || "Untitled",
          onItemClick: () => {
            editor.insertInlineContent([
              {
                type: "pageLink" as const,
                props: {
                  docId: doc.id,
                  docTitle: doc.title || "Untitled",
                },
              },
              " ",
            ]);
          },
          icon: <FileText size={14} />,
        }));

      return filterSuggestionItems(items, query);
    },
    [editor, _dbDocuments, document.id]
  );

  // ─── Auto-save on content change ───
  //
  // Saves are guarded by `updated_at` (see updateDocument). The row's
  // `updated_at` also moves for writes that are not edits — the indexer's
  // bookkeeping, a title/settings save, a keepalive flush — so a mismatch alone
  // is not a conflict. We remember every content string this client has loaded
  // or written; if the server's content is one of ours, we adopt its timestamp
  // and retry. Only genuinely foreign content is surfaced as a conflict, and
  // then the local blocks are kept until the user picks a side.

  const triggerIndex = useCallback((docId: string) => {
    authedFetch("/api/ai/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: docId }),
    }).catch((err) =>
      console.error("[AI index] Failed to trigger indexing:", err)
    );
  }, []);

  const scheduleIndex = useCallback(
    (immediate: boolean) => {
      if (indexTimeoutRef.current) {
        clearTimeout(indexTimeoutRef.current);
        indexTimeoutRef.current = null;
      }
      if (immediate) {
        triggerIndex(document.id);
        return;
      }
      indexTimeoutRef.current = setTimeout(() => {
        indexTimeoutRef.current = null;
        triggerIndex(document.id);
      }, 30_000);
    },
    [document.id, triggerIndex]
  );

  useEffect(() => {
    rememberOwnWrite(document.id, document.content);
    // Mount-scoped: the content this editor instance was seeded from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id]);

  /** Replace the editor's blocks with a server version and treat it as the new base. */
  const applyRemoteDocument = useCallback(
    (remote: RemoteDocument) => {
      seedingRef.current = true;
      try {
        const parsed = JSON.parse(remote.content);
        if (Array.isArray(parsed) && parsed.length > 0) {
          editor.replaceBlocks(editor.document, parsed);
        }
      } catch {
        // leave local blocks if remote content is unreadable
      } finally {
        queueMicrotask(() => {
          seedingRef.current = false;
        });
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      baseUpdatedAtRef.current = remote.updatedAt;
      baseContentRef.current = remote.content;
      rememberOwnWrite(document.id, remote.content);
      conflictRef.current = null;
      setConflict(null);
      setTitle(remote.title);
      setSubtitle(remote.subtitle || "");
      setSyncStatus("synced");
      setLastSavedAt(Date.parse(remote.updatedAt) || Date.now());
    },
    [editor, document.id]
  );

  const collectMeta = useCallback(() => {
    const meta: { title?: string; subtitle?: string | null } = {};
    const titleNow = titleRef.current.trim() || "Untitled";
    const subtitleNow = subtitleRef.current;
    if (titleNow !== document.title) meta.title = titleNow;
    if (subtitleNow !== (document.subtitle || "")) meta.subtitle = subtitleNow || null;
    return meta;
  }, [document.title, document.subtitle]);

  const runSave = useCallback(
    async (opts: { flush: boolean }) => {
      const idle = () => !saveTimeoutRef.current && !queuedSaveRef.current;
      let adoptions = 0;

      for (;;) {
        const content = JSON.stringify(editor.document);
        const meta = collectMeta();
        const hasMeta = meta.title !== undefined || meta.subtitle !== undefined;

        if (content === baseContentRef.current && !hasMeta) {
          // The server already has this exact content.
          if (idle()) setSyncStatus("synced");
          if (opts.flush && indexTimeoutRef.current) scheduleIndex(true);
          return;
        }

        setSyncStatus("saving");
        rememberOwnWrite(document.id, content);
        const expectedUpdatedAt = baseUpdatedAtRef.current;

        try {
          const saved = await saveDocument(document.id, {
            content,
            ...meta,
            ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
          });
          baseUpdatedAtRef.current = saved.updatedAt;
          baseContentRef.current = saved.content;
          rememberOwnWrite(document.id, saved.content);
          conflictRef.current = null;
          setConflict(null);

          try {
            const targetIds = parseBacklinks(content, _dbDocuments);
            await syncBacklinks(document.id, targetIds);
          } catch (err) {
            console.error("Failed to sync backlinks:", err);
          }

          setLastSavedAt(Date.now());
          if (idle()) setSyncStatus("synced");
          scheduleIndex(opts.flush);
          return;
        } catch (err) {
          if (err instanceof StaleWriteError) {
            const remote = dbDocumentToDocument(err.current);
            if (isOwnWrite(document.id, remote.content) && adoptions < 3) {
              // updated_at moved but the content is ours (index bookkeeping,
              // a keepalive flush, a meta save). Adopt the timestamp and retry.
              adoptions++;
              baseUpdatedAtRef.current = remote.updatedAt;
              baseContentRef.current = remote.content;
              continue;
            }
            if (opts.flush) {
              console.warn(
                "[editor] Dropped flush for document changed elsewhere:",
                document.id
              );
              return;
            }
            console.warn("[editor] Document changed elsewhere — holding local edits");
            conflictRef.current = remote;
            setConflict(remote);
            setSyncStatus("conflict");
            return;
          }
          console.error("Failed to save document:", err);
          setSyncStatus("error");
          return;
        }
      }
    },
    [editor, document.id, saveDocument, _dbDocuments, collectMeta, scheduleIndex]
  );

  /**
   * Serialised entry point for saves. A second call while one is in flight is
   * queued and run once, after the first completes, so two saves never race on
   * the same base timestamp.
   */
  const persistContent = useCallback(
    async (opts?: { flush?: boolean }) => {
      const flush = opts?.flush === true;
      const running = saveRunRef.current;
      if (running && Date.now() - running.startedAt < SAVE_STALL_MS) {
        queuedSaveRef.current = {
          flush: flush || (queuedSaveRef.current?.flush ?? false),
        };
        return;
      }
      const token = ++saveTokenCounter;
      saveRunRef.current = { token, startedAt: Date.now() };
      try {
        await runSave({ flush });
      } finally {
        if (saveRunRef.current?.token === token) {
          saveRunRef.current = null;
          const queued = queuedSaveRef.current;
          queuedSaveRef.current = null;
          if (queued) void persistRef.current(queued);
        }
      }
    },
    [runSave]
  );
  persistRef.current = persistContent;

  const handleEditorChange = useCallback(() => {
    if (seedingRef.current) return;
    // While a conflict banner is up, hold edits locally until the user decides.
    if (conflictRef.current) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSyncStatus("pending");
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      void persistContent();
    }, 1000);
  }, [persistContent]);

  // Conflict banner actions.
  const resolveKeepMine = useCallback(() => {
    const remote = conflictRef.current;
    if (!remote) return;
    // Overwrite on top of the remote version, deliberately.
    baseUpdatedAtRef.current = remote.updatedAt;
    conflictRef.current = null;
    setConflict(null);
    setSyncStatus("pending");
    void persistContent();
  }, [persistContent]);

  const resolveLoadTheirs = useCallback(() => {
    const remote = conflictRef.current;
    if (!remote) return;
    // Prefer whatever the store has if a later foreign save arrived meanwhile.
    const latest = useAppStore.getState().activeDocument;
    const newest =
      latest && latest.id === document.id && isNewerTimestamp(latest.updatedAt, remote.updatedAt)
        ? { content: latest.content, updatedAt: latest.updatedAt, title: latest.title, subtitle: latest.subtitle }
        : remote;
    applyRemoteDocument(newest);
  }, [applyRemoteDocument, document.id]);

  // React to the store handing us a different version of this document.
  useEffect(() => {
    if (!document.updatedAt || document.updatedAt === baseUpdatedAtRef.current) {
      return;
    }
    // An older row (a slow refetch that lost the race with our save) is noise.
    if (isNewerTimestamp(baseUpdatedAtRef.current, document.updatedAt)) return;

    if (isOwnWrite(document.id, document.content)) {
      // The row moved without a foreign edit (index bookkeeping, a title or
      // settings save, our own flush). Adopt the timestamp, leave the blocks.
      baseUpdatedAtRef.current = document.updatedAt;
      baseContentRef.current = document.content;
      return;
    }

    // Foreign content. Only swap it in when nothing local is unsaved;
    // otherwise the next save detects the conflict and asks.
    if (
      syncStatusRef.current !== "synced" ||
      saveTimeoutRef.current ||
      saveRunRef.current ||
      queuedSaveRef.current
    ) {
      return;
    }
    applyRemoteDocument({
      content: document.content,
      updatedAt: document.updatedAt,
      title: document.title,
      subtitle: document.subtitle,
    });
  }, [
    document.id,
    document.updatedAt,
    document.content,
    document.title,
    document.subtitle,
    applyRemoteDocument,
  ]);

  // Flush pending save + index on unmount (doc switch, tab close).
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (syncStatusRef.current !== "synced") {
        void persistRef.current({ flush: true });
      } else if (indexTimeoutRef.current) {
        clearTimeout(indexTimeoutRef.current);
        indexTimeoutRef.current = null;
        triggerIndex(document.id);
      }
    };
  }, [document.id, triggerIndex]);

  // Save when the tab is hidden; keepalive-flush and warn on unload.
  useEffect(() => {
    const keepaliveFlush = () => {
      if (syncStatusRef.current === "synced" || conflictRef.current) return;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const content = JSON.stringify(editor.document);
      rememberOwnWrite(document.id, content);
      keepalivePatchDocument(
        document.id,
        { content, ...collectMeta() },
        baseUpdatedAtRef.current
      );
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (syncStatusRef.current === "synced") return;
      keepaliveFlush();
      e.preventDefault();
      e.returnValue = "";
    };
    const onPageHide = () => keepaliveFlush();
    const onVisibility = () => {
      if (window.document.visibilityState !== "hidden") return;
      if (syncStatusRef.current === "synced" || conflictRef.current) return;
      // The page is still alive here, so use the normal guarded save: it can
      // adopt a moved timestamp and it updates our base on success.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      void persistContent();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      window.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [editor, document.id, collectMeta, persistContent]);

  // ─── Title / subtitle / tags handlers ───

  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim() || "Untitled";
    if (trimmed !== document.title) {
      saveDocument(document.id, { title: trimmed });
    }
  }, [title, document.id, document.title, saveDocument]);

  const handleSubtitleBlur = useCallback(() => {
    if (subtitle !== (document.subtitle || "")) {
      saveDocument(document.id, { subtitle: subtitle || null });
    }
  }, [subtitle, document.id, document.subtitle, saveDocument]);

  const addTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      const newTags = [...tags, tag];
      setTags(newTags);
      setTagInput("");
      saveDocument(document.id, { tags: newTags });
    }
  }, [tagInput, tags, document.id, saveDocument]);

  const removeTag = useCallback(
    (tagToRemove: string) => {
      const newTags = tags.filter((t) => t !== tagToRemove);
      setTags(newTags);
      saveDocument(document.id, { tags: newTags });
    },
    [tags, document.id, saveDocument]
  );

  // ─── Custom drag handle menu with "Add to context" + "Annotation Chat" ───

  const CustomDragHandleMenu = useCallback(
    () => (
      <DragHandleMenu>
        <RemoveBlockItem>Delete</RemoveBlockItem>
        <BlockColorsItem>Colors</BlockColorsItem>
        <AddToContextItem docTitle={document.title || "Untitled"}>
          <span className="flex items-center gap-2">
            <MessageSquarePlus size={14} />
            Add to context
          </span>
        </AddToContextItem>
        <AnnotateChatItem documentId={document.id}>
          <span className="flex items-center gap-2">
            <MessageSquare size={14} />
            Annotation Chat
          </span>
        </AnnotateChatItem>
      </DragHandleMenu>
    ),
    [document.title, document.id]
  );

  // ─── Custom formatting toolbar with Annotate button ───

  const CustomFormattingToolbar = useCallback(
    () => (
      <FormattingToolbar>
        {...getFormattingToolbarItems()}
        <AnnotateToolbarButton documentId={document.id} />
      </FormattingToolbar>
    ),
    [document.id]
  );

  const activeAnnotation = useAppStore((s) => s.activeAnnotation);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const savedSec = Math.max(0, Math.floor((now - lastSavedAt) / 1000));
  const savedLabel =
    savedSec < 20 ? "now" :
    savedSec < 60 ? `${savedSec}s` :
    savedSec < 3600 ? `${Math.floor(savedSec / 60)}m` :
    savedSec < 86400 ? `${Math.floor(savedSec / 3600)}h` :
    new Date(lastSavedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div ref={containerRef} className="relative">
      {/* Sync status dot */}
      {!isIndexDoc && (
      <div className="sticky top-0 left-0 h-0 z-10 pointer-events-none">
        <div className="flex items-start justify-between px-3 pt-3">
          {/* Left: sync dot */}
          <div
            className="inline-flex items-center gap-1.5"
            title={
              syncStatus === "synced" ? "All changes saved" :
              syncStatus === "pending" ? "Unsaved changes" :
              syncStatus === "saving" ? "Saving…" :
              syncStatus === "conflict" ? "Changed elsewhere — unsaved" :
              "Save failed"
            }
          >
            <span
              className="block w-2 h-2 rounded-full transition-colors duration-300 pointer-events-auto"
              style={{
                backgroundColor:
                  syncStatus === "synced" ? "#22c55e" :
                  syncStatus === "pending" ? "#eab308" :
                  syncStatus === "saving" ? "#eab308" :
                  syncStatus === "conflict" ? "#f97316" :
                  "#ef4444",
                boxShadow:
                  syncStatus === "error" ? "0 0 4px rgba(239,68,68,0.5)" : undefined,
              }}
            />
            <span
              className="text-[10px] leading-none text-muted-foreground pointer-events-auto tabular-nums"
              title={new Date(lastSavedAt).toLocaleString()}
            >
              {savedLabel}
            </span>
          </div>
          {/* Right: settings */}
          <NoteSettingsButton settings={noteSettings} onChange={handleSettingsChange} docId={document.id} shareSlug={document.shareSlug} />
        </div>
      </div>
      )}
      {/* Conflict banner: a save collided with a version written elsewhere */}
      {conflict && !isIndexDoc && (
        <div className="sticky top-0 z-20 h-0 pointer-events-none">
          <div className="flex justify-center px-3 pt-8">
            <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-sidebar-bg px-3 py-1.5 text-xs shadow-sm">
              <span className="text-muted-foreground">
                This note was changed elsewhere. Your edits here are unsaved.
              </span>
              <button
                type="button"
                onClick={resolveLoadTheirs}
                className="px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
              >
                Load theirs
              </button>
              <button
                type="button"
                onClick={resolveKeepMine}
                className="px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
              >
                Keep mine
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className={`px-14 py-12 ${noteSettings.fullWidth ? '' : 'max-w-[800px]'}`}
        style={{
          marginLeft: activeAnnotation || noteSettings.fullWidth
            ? '2rem'
            : 'max(0px, calc(50% - 400px))',
          paddingBottom: activeAnnotation ? '420px' : undefined,
          transition: 'margin-left 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          '--note-font-size': noteSettings.fontSize ? `${16 * noteSettings.fontSize}px` : '16px',
          fontFamily: noteSettings.font || undefined,
        } as React.CSSProperties}
      >
      {/* Title */}
      <div className="mb-6">
        {isIndexDoc ? (
          <h1
            className="w-full font-normal text-foreground leading-tight"
            style={{ fontSize: 'calc(var(--note-font-size, 16px) * 2.4375)' }}
          >{title}</h1>
        ) : (
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Title"
          className="w-full font-normal text-foreground bg-transparent border-none outline-none placeholder:text-muted leading-tight p-0"
          style={{ fontSize: 'calc(var(--note-font-size, 16px) * 2.4375)' }}
        />
        )}
      </div>

      {/* Inline entry input for todo / quick notes parent */}
      {hasEntryInput && (
        <div className="mb-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!entryInput.trim()) return;
              const text = entryInput.trim();
              setEntryInput("");
              if (document.docType === "todo") {
                await addTodo(text);
              } else {
                await addQuickNote(text);
              }
              // The store already persisted and cached the rewritten blocks.
              // Seed the editor from the cache as a remote version so the
              // change is adopted as our own rather than autosaved again.
              const cached = useAppStore.getState()._documentCache.get(document.id);
              if (cached) {
                applyRemoteDocument({
                  content: cached.content,
                  updatedAt: cached.updatedAt,
                  title: cached.title,
                  subtitle: cached.subtitle,
                });
              }
              entryInputRef.current?.focus();
            }}
            className="flex items-center gap-2"
          >
            <input
              ref={entryInputRef}
              value={entryInput}
              onChange={(e) => setEntryInput(e.target.value)}
              placeholder={document.docType === "todo" ? "Add a todo…" : "Jot something down…"}
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-border bg-white focus:outline-none focus:ring-1 focus:ring-black/10 placeholder:text-muted-foreground/60"
            />
            <button
              type="submit"
              disabled={!entryInput.trim()}
              className="shrink-0 p-1.5 rounded-lg border border-border hover:bg-black/5 disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <Plus size={16} />
            </button>
          </form>
        </div>
      )}

      {/* Subtitle + Tags */}
      {!isIndexDoc && (
      <div className="mb-8 space-y-2">
        <input
          type="text"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          onBlur={handleSubtitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Subtitle"
          className="w-full text-foreground bg-transparent border-none outline-none placeholder:text-muted p-0"
          style={{ fontSize: 'calc(var(--note-font-size, 16px) * 1.125)' }}
        />

        {/* Tags row */}
        <div className="flex items-start gap-2">
          <span
            className="text-muted-foreground shrink-0 pt-0.5"
            style={{ fontSize: "calc(var(--note-font-size, 16px) * 0.8125)" }}
          >
            Tags:
          </span>
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full border border-border text-muted-foreground bg-white"
                style={{ fontSize: "calc(var(--note-font-size, 16px) * 0.8125)" }}
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTag();
                if (
                  e.key === "Backspace" &&
                  !tagInput &&
                  tags.length > 0
                ) {
                  removeTag(tags[tags.length - 1]);
                }
              }}
              placeholder="Add tag..."
              className="bg-transparent border-none outline-none placeholder:text-muted w-[72px] py-0.5"
              style={{ fontSize: "calc(var(--note-font-size, 16px) * 0.8125)" }}
            />
          </div>
        </div>
      </div>
      )}

      {/* BlockNote Editor */}
      <div className={`min-h-[400px]${isIndexDoc ? " read-only-index" : ""}`}>
        <BlockNoteView
          editor={editor}
          onChange={isIndexDoc ? undefined : handleEditorChange}
          theme="light"
          editable={!isIndexDoc}
          slashMenu={false}
          sideMenu={false}
          formattingToolbar={false}
          className="[&_.bn-editor]:!px-0"
        >
          {!isIndexDoc && (
            <>
          {/* Custom formatting toolbar with Annotate button */}
          <FormattingToolbarController
            formattingToolbar={CustomFormattingToolbar}
          />
          {/* Custom side menu with "Add to context" + "Annotation Chat" in drag handle */}
          <SideMenuController
            sideMenu={(props) => (
              <SideMenu {...props} dragHandleMenu={CustomDragHandleMenu} />
            )}
          />
          {/* Custom slash menu: default items + pages group */}
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => getSlashMenuItems(query)}
          />
          {/* @ mention menu for quick page linking */}
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) => getPageMentionItems(query)}
          />
            </>
          )}
        </BlockNoteView>
      </div>
      </div>

      {/* Annotation markers on blocks */}
      <AnnotationMarkers containerRef={containerRef} />

      {/* Floating annotation chat */}
      {activeAnnotation && (
        <FloatingAnnotationChat
          containerRef={containerRef}
          blockId={activeAnnotation.blockId}
        />
      )}
    </div>
  );
}
