"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { Document, Annotation, NoteSettings } from "@/lib/types";
import { parseBacklinks, syncBacklinks, createDocument as dbCreateDocument } from "@/lib/db";
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
  const [syncStatus, setSyncStatus] = useState<"synced" | "pending" | "saving" | "error">("synced");
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

  const handleSettingsChange = useCallback(
    (newSettings: NoteSettings) => {
      setNoteSettings(newSettings);
      saveDocument(document.id, { settings: newSettings });
    },
    [document.id, saveDocument]
  );

  // Load annotations for this document
  useEffect(() => {
    loadAnnotations(document.id);
  }, [document.id, loadAnnotations]);

  // Parse initial content for BlockNote
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let initialContent: any[] | undefined;
  try {
    const parsed = JSON.parse(document.content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      initialContent = parsed;
    }
  } catch {
    initialContent = undefined;
  }

  const editor = useCreateBlockNote({
    schema,
    initialContent,
    dropCursor: multiColumnDropCursor,
    dictionary: {
      ...locales.en,
      multi_column: multiColumnLocales.en,
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

  const handleEditorChange = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSyncStatus("pending");
    saveTimeoutRef.current = setTimeout(async () => {
      setSyncStatus("saving");
      try {
        const blocks = editor.document;
        const content = JSON.stringify(blocks);
        await saveDocument(document.id, { content });

        // Parse and sync backlinks (supports both [[wikilinks]] and pageLink nodes)
        try {
          const targetIds = parseBacklinks(content, _dbDocuments);
          await syncBacklinks(document.id, targetIds);
        } catch (err) {
          console.error("Failed to sync backlinks:", err);
        }
        setSyncStatus("synced");

        // Debounced AI indexing (30s after last save)
        if (indexTimeoutRef.current) {
          clearTimeout(indexTimeoutRef.current);
        }
        indexTimeoutRef.current = setTimeout(() => {
          fetch("/api/ai/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId: document.id }),
          }).catch((err) =>
            console.error("[AI index] Failed to trigger indexing:", err)
          );
        }, 30_000);
      } catch (err) {
        console.error("Failed to save document:", err);
        setSyncStatus("error");
      }
    }, 1000);
  }, [editor, document.id, saveDocument, _dbDocuments]);

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

  // Clean up timeouts on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (indexTimeoutRef.current) {
        clearTimeout(indexTimeoutRef.current);
      }
    };
  }, []);

  const activeAnnotation = useAppStore((s) => s.activeAnnotation);

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
                  "#ef4444",
                boxShadow:
                  syncStatus === "error" ? "0 0 4px rgba(239,68,68,0.5)" : undefined,
              }}
            />
          </div>
          {/* Right: settings */}
          <NoteSettingsButton settings={noteSettings} onChange={handleSettingsChange} docId={document.id} shareSlug={document.shareSlug} />
        </div>
      </div>
      )}
      <div
        className={`px-14 py-12 ${noteSettings.fullWidth ? '' : 'max-w-[800px]'}`}
        style={{
          marginLeft: activeAnnotation ? '2rem' : (noteSettings.fullWidth ? '2rem' : 'calc(50% - 400px)'),
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
          className="w-full font-normal text-foreground bg-transparent border-none outline-none placeholder:text-muted leading-tight"
          style={{ fontSize: 'calc(var(--note-font-size, 16px) * 2.4375)' }}
        />
        )}
      </div>

      {/* Inline entry input for todo / quick notes parent */}
      {hasEntryInput && (
        <div className="mb-4 pl-14">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!entryInput.trim()) return;
              const text = entryInput.trim();
              setEntryInput("");
              if (document.docType === "todo") {
                await addTodo(text);
                // Update editor from cache — addTodo already persisted & cached
                try {
                  const cached = useAppStore.getState()._documentCache.get(document.id);
                  if (cached) {
                    const parsed = JSON.parse(cached.content);
                    if (Array.isArray(parsed)) {
                      editor.replaceBlocks(editor.document, parsed);
                    }
                  }
                } catch { /* ignore */ }
              } else {
                await addQuickNote(text);
                // Refresh editor blocks — database block was synced
                try {
                  const cached = useAppStore.getState()._documentCache.get(document.id);
                  if (cached) {
                    const parsed = JSON.parse(cached.content);
                    if (Array.isArray(parsed)) {
                      editor.replaceBlocks(editor.document, parsed);
                    }
                  }
                } catch { /* ignore */ }
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
      <div className="mb-8 pl-14 space-y-2">
        <input
          type="text"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          onBlur={handleSubtitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Subtitle"
          className="w-full text-foreground bg-transparent border-none outline-none placeholder:text-muted"
          style={{ fontSize: 'calc(var(--note-font-size, 16px) * 1.125)' }}
        />

        {/* Tags row */}
        <div className="flex items-center gap-4">
          <span className="text-lg text-foreground">Tags:</span>
          <div className="flex items-center gap-2 flex-wrap">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-3 py-0.5 rounded-full border border-border text-[13px] text-foreground bg-white"
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={10} />
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
              className="text-[13px] bg-transparent border-none outline-none placeholder:text-muted w-[80px]"
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
