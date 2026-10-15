import type { DbDocument, DocType } from "@cortex/types";
import {
  PINNED_DOC_TYPES,
  ROOT_KEY,
  buildTreeIndex,
  createChildSorter,
  flattenTree,
  type TreeIndex,
  type TreeRow,
} from "@cortex/fileTree";
import { Stack, useRouter } from "expo-router";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { signOut } from "@/lib/auth";
import { useAppStore } from "@/lib/store";
import { usePalette, type Palette } from "@/lib/theme";

const DOC_ICONS: Partial<Record<DocType, SFSymbol>> = {
  daily: "calendar",
  daily_parent: "calendar",
  todo: "checklist",
  quick_note_parent: "bolt",
  moodboard: "photo.on.rectangle",
};

// Same order the web sidebar pins them in.
const PINNED_ORDER: DocType[] = ["daily_parent", "quick_note_parent", "todo"];

export default function RootScreen() {
  const router = useRouter();
  const palette = usePalette();
  const tree = useAppStore((s) => s.tree);
  const treeLoading = useAppStore((s) => s.treeLoading);
  const treeError = useAppStore((s) => s.treeError);
  const expandedFolderIds = useAppStore((s) => s.expandedFolderIds);
  const expandedDocIds = useAppStore((s) => s.expandedDocIds);
  const loadTree = useAppStore((s) => s.loadTree);
  const toggleExpanded = useAppStore((s) => s.toggleExpanded);
  const openNote = useAppStore((s) => s.openNote);

  useEffect(() => {
    void loadTree();
    // Pick up notes created or moved on desktop while backgrounded.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadTree();
    });
    return () => sub.remove();
  }, [loadTree]);

  const index = useMemo(
    () => (tree ? buildTreeIndex(tree.folders, tree.documents) : null),
    [tree],
  );

  const rows = useMemo(() => {
    if (!index) return [];
    return flattenTree(index, createChildSorter(index, "manual", "asc"), {
      rootKey: ROOT_KEY,
      expandedFolderIds,
      expandedDocIds,
    });
  }, [index, expandedFolderIds, expandedDocIds]);

  const pinned = useMemo(() => {
    if (!index) return [];
    return (index.children.get(ROOT_KEY) ?? [])
      .filter((k) => k.startsWith("doc:"))
      .map((k) => index.docs.get(k.slice(4)))
      .filter((d): d is DbDocument => !!d && PINNED_DOC_TYPES.has(d.doc_type))
      .sort(
        (a, b) =>
          PINNED_ORDER.indexOf(a.doc_type) - PINNED_ORDER.indexOf(b.doc_type),
      );
  }, [index]);

  const open = useCallback(
    (docId: string) => {
      openNote(docId);
      router.navigate("/note");
    },
    [openNote, router],
  );

  const renderRow = useCallback(
    ({ item }: { item: TreeRow }) =>
      index ? (
        <TreeRowView
          row={item}
          index={index}
          palette={palette}
          onOpen={open}
          onToggle={toggleExpanded}
        />
      ) : null,
    [index, palette, open, toggleExpanded],
  );

  return (
    <>
      <Stack.Screen options={{ title: "Cortex" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis">
          <Stack.Toolbar.MenuAction
            icon="rectangle.portrait.and.arrow.right"
            destructive
            onPress={() => void signOut()}
          >
            Sign Out
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <FlatList
        style={{ backgroundColor: palette.background }}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        refreshControl={
          <RefreshControl
            refreshing={treeLoading && !!tree}
            onRefresh={() => void loadTree()}
          />
        }
        ListHeaderComponent={
          pinned.length > 0 ? (
            <View
              style={[styles.pinned, { borderBottomColor: palette.border }]}
            >
              {pinned.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => open(d.id)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: palette.fill },
                  ]}
                >
                  <SymbolView
                    name={DOC_ICONS[d.doc_type] ?? "doc.text"}
                    size={18}
                    tintColor={palette.muted}
                  />
                  <Text
                    style={[styles.title, { color: palette.text }]}
                    numberOfLines={1}
                  >
                    {d.title || "Untitled"}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {treeError ? (
              <Text style={{ color: palette.muted }}>
                Couldn’t load notes: {treeError}
              </Text>
            ) : treeLoading ? (
              <ActivityIndicator />
            ) : (
              <Text style={{ color: palette.muted }}>No notes yet</Text>
            )}
          </View>
        }
      />
    </>
  );
}

function TreeRowView({
  row,
  index,
  palette,
  onOpen,
  onToggle,
}: {
  row: TreeRow;
  index: TreeIndex;
  palette: Palette;
  onOpen: (docId: string) => void;
  onToggle: (kind: "folder" | "doc", id: string) => void;
}) {
  const isFolder = row.kind === "folder";
  const doc = isFolder ? undefined : index.docs.get(row.id);
  const title = isFolder
    ? index.folders.get(row.id)?.name || "Untitled folder"
    : doc?.title || "Untitled";
  const expandable = isFolder || row.hasChildren;
  const icon: SFSymbol = isFolder
    ? row.expanded
      ? "folder.fill"
      : "folder"
    : (doc && DOC_ICONS[doc.doc_type]) || "doc.text";

  return (
    <Pressable
      onPress={() => (isFolder ? onToggle("folder", row.id) : onOpen(row.id))}
      style={({ pressed }) => [
        styles.row,
        { paddingLeft: 12 + row.depth * 18 },
        pressed && { backgroundColor: palette.fill },
      ]}
    >
      <Pressable
        hitSlop={10}
        disabled={!expandable}
        onPress={() => onToggle(row.kind, row.id)}
        style={styles.chevron}
      >
        {expandable && (
          <SymbolView
            name={row.expanded ? "chevron.down" : "chevron.right"}
            size={12}
            weight="semibold"
            tintColor={palette.muted}
          />
        )}
      </Pressable>
      <SymbolView
        name={icon}
        size={18}
        tintColor={isFolder ? palette.text : palette.muted}
      />
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pinned: {
    paddingVertical: 6,
    marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  chevron: {
    width: 14,
    alignItems: "center",
    marginRight: -2,
  },
  title: {
    flex: 1,
    fontSize: 17,
  },
  empty: {
    paddingTop: 80,
    alignItems: "center",
  },
});
