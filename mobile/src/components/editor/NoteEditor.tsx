"use dom";

// Metro doesn't follow CSS `@import`, so @blocknote/mantine/style.css (a list
// of imports) arrives empty; load its leaf stylesheets instead. Mantine's
// global styles come along with styles.css — harmless in a web view we own.
// No @blocknote/core/fonts/inter.css either: Metro can't bundle its url()
// fonts, and BlockNote's font stack falls back to the iOS system font.
import "@mantine/core/styles.css";
import "@blocknote/react/style.css";
import "@blocknote/mantine/blocknoteStyles.css";
import "./editor.css";

import { combineByGroup } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import * as locales from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import {
  getMultiColumnSlashMenuItems,
  locales as multiColumnLocales,
  multiColumnDropCursor,
} from "@blocknote/xl-multi-column";
import { useDOMImperativeHandle, type DOMProps } from "expo/dom";
import { useEffect, useLayoutEffect, useMemo, type Ref } from "react";

import { findUnsupportedTypes, schema, setOpenDocHandler } from "./schema";
import type { NoteEditorHandle } from "./types";

type Props = {
  docId: string;
  /** `updated_at` of the loaded copy; a new value rebuilds the editor from `initialContent`. */
  revision: string;
  /** JSON-stringified BlockNote block array (`documents.content`). */
  initialContent: string;
  editable: boolean;
  colorScheme: "light" | "dark";
  /** Debounced. Carries `docId` because a flush can land after a switch to another note. */
  onChangeContent: (docId: string, content: string) => Promise<void>;
  onOpenDoc: (docId: string) => Promise<void>;
  onFocusChange: (focused: boolean) => Promise<void>;
  ref?: Ref<NoteEditorHandle>;
  dom?: DOMProps;
};

const CHANGE_DEBOUNCE_MS = 300;

/**
 * Debounced "content changed" pump, one per editor instance. Lives outside the
 * component so its timer state is plain closure state, not render state; the
 * sender is attached from an effect so it always sees the latest props.
 */
function createChangePump() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let send: (() => void) | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty || !send) return;
    dirty = false;
    send();
  };
  const schedule = () => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, CHANGE_DEBOUNCE_MS);
  };
  const setSender = (next: () => void) => {
    send = next;
  };
  return { flush, schedule, setSender };
}

function parseBlocks(json: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Empty or corrupt body opens as a blank note.
  }
  return undefined;
}

export default function NoteEditor({
  docId,
  revision,
  initialContent,
  editable,
  colorScheme,
  onChangeContent,
  onOpenDoc,
  onFocusChange,
  ref,
}: Props) {
  useEffect(() => {
    setOpenDocHandler((id) => void onOpenDoc(id));
    return () => setOpenDocHandler(null);
  }, [onOpenDoc]);

  useEffect(() => {
    document.documentElement.dataset.theme = colorScheme;
  }, [colorScheme]);

  // Parsed once per loaded copy; later prop updates must not rebuild the editor.
  const blocks = useMemo(
    () => parseBlocks(initialContent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, revision],
  );
  const unsupported = useMemo(
    () => (blocks ? findUnsupportedTypes(blocks) : []),
    [blocks],
  );

  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: unsupported.length === 0 ? (blocks as any) : undefined,
      dropCursor: multiColumnDropCursor,
      dictionary: { ...locales.en, multi_column: multiColumnLocales.en },
    },
    [docId, revision],
  );

  // Debounced change pump, scoped to one editor instance. Its cleanup flushes,
  // so switching notes never drops the last few keystrokes.
  const pump = useMemo(
    () => createChangePump(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );
  useLayoutEffect(() => {
    pump.setSender(
      () => void onChangeContent(docId, JSON.stringify(editor.document)),
    );
  }, [pump, onChangeContent, docId, editor]);
  useEffect(() => () => pump.flush(), [pump]);

  useDOMImperativeHandle(
    ref as Ref<NoteEditorHandle>,
    () => ({
      flush: () => pump.flush(),
      blur: () => (document.activeElement as HTMLElement | null)?.blur(),
    }),
    [pump],
  );

  // Native shows a Done button while the editor holds focus.
  useEffect(() => {
    let focused = !!document.activeElement?.closest?.(".bn-editor");
    const update = () => {
      const next = !!document.activeElement?.closest?.(".bn-editor");
      if (next === focused) return;
      focused = next;
      void onFocusChange(next);
    };
    const onFocusOut = () => setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [onFocusChange]);

  if (unsupported.length > 0) {
    return (
      <div className="cx-notice">
        This note uses content the mobile editor can’t show yet (
        <code>{unsupported.join(", ")}</code>). Open it on desktop — it’s left
        untouched here.
      </div>
    );
  }

  return (
    <BlockNoteView
      editor={editor}
      editable={editable}
      theme={colorScheme}
      onChange={editable ? pump.schedule : undefined}
      sideMenu={false}
      slashMenu={false}
      tableHandles={false}
    >
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query) =>
          filterSuggestionItems(
            combineByGroup(
              getDefaultReactSlashMenuItems(editor as any),
              getMultiColumnSlashMenuItems(editor as any),
            ),
            query,
          )
        }
      />
    </BlockNoteView>
  );
}
