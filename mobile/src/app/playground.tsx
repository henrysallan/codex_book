// Dev-only: the editor with a sample note covering every custom node type,
// so editor behavior can be checked without signing in. Nothing is saved.

import { Stack } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";

import NoteEditor from "@/components/editor/NoteEditor";
import type { NoteEditorHandle } from "@/components/editor/types";
import { usePalette, useScheme } from "@/lib/theme";

const p = {
  textColor: "default",
  backgroundColor: "default",
  textAlignment: "left",
};
const text = (t: string, styles = {}) => ({ type: "text", text: t, styles });

const SAMPLE = JSON.stringify([
  {
    id: "h1",
    type: "heading",
    props: { ...p, level: 2 },
    content: [text("Editor playground")],
    children: [],
  },
  {
    id: "p1",
    type: "paragraph",
    props: p,
    content: [
      text("Plain, "),
      text("bold", { bold: true }),
      text(", "),
      text("italic", { italic: true }),
      text(", and a page link: "),
      {
        type: "pageLink",
        props: { docId: "sample-doc", docTitle: "Linked note" },
      },
    ],
    children: [],
  },
  {
    id: "c1",
    type: "checkListItem",
    props: { ...p, checked: false },
    content: [text("A todo")],
    children: [],
  },
  {
    id: "c2",
    type: "checkListItem",
    props: { ...p, checked: true },
    content: [text("A done todo")],
    children: [],
  },
  {
    id: "b1",
    type: "bulletListItem",
    props: p,
    content: [text("Bullet")],
    children: [
      {
        id: "b2",
        type: "bulletListItem",
        props: p,
        content: [text("Nested bullet")],
        children: [],
      },
    ],
  },
  {
    id: "cl",
    type: "columnList",
    props: {},
    children: [
      {
        id: "col1",
        type: "column",
        props: { width: 1 },
        children: [
          {
            id: "cp1",
            type: "paragraph",
            props: p,
            content: [text("Left column")],
            children: [],
          },
        ],
      },
      {
        id: "col2",
        type: "column",
        props: { width: 1 },
        children: [
          {
            id: "cp2",
            type: "paragraph",
            props: p,
            content: [text("Right column")],
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: "db",
    type: "database",
    props: {
      columns: JSON.stringify([
        { id: "t", name: "Title", type: "text", width: 400, isTitle: true },
      ]),
      rows: JSON.stringify([
        { id: "r1", docId: "sample-1", cells: { t: "First row note" } },
        { id: "r2", docId: "sample-2", cells: { t: "Second row note" } },
      ]),
    },
    children: [],
  },
  {
    id: "p2",
    type: "paragraph",
    props: p,
    content: [text("Type / for the block menu.")],
    children: [],
  },
]);

export default function Playground() {
  const palette = usePalette();
  const scheme = useScheme();
  const ref = useRef<NoteEditorHandle>(null);
  const [focused, setFocused] = useState(false);
  const [lastEvent, setLastEvent] = useState("");

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Stack.Screen
        options={{ headerTitle: lastEvent || "Editor Playground" }}
      />
      {focused && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            variant="done"
            onPress={() => ref.current?.blur()}
          >
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <NoteEditor
        ref={ref}
        docId="playground"
        revision="1"
        initialContent={SAMPLE}
        editable
        colorScheme={scheme}
        onChangeContent={async (_id, content) =>
          setLastEvent(`Changed · ${content.length} chars`)
        }
        onOpenDoc={async (docId) => setLastEvent(`Open ${docId}`)}
        onFocusChange={async (next) => setFocused(next)}
        dom={{
          style: { flex: 1 },
          hideKeyboardAccessoryView: true,
          contentInsetAdjustmentBehavior: "automatic",
        }}
      />
    </View>
  );
}
