import type { DbDocument } from "@cortex/types";
import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { SFSymbol } from "expo-symbols";

import NoteEditor from "@/components/editor/NoteEditor";
import type { NoteEditorHandle } from "@/components/editor/types";
import { fetchDocument } from "@/lib/api";
import {
  baseVersion,
  enqueue,
  flushAll,
  hasUnsaved,
  resolveKeepMine,
  resolveUseTheirs,
  retry,
  setSaveHandlers,
  trackLoaded,
  useSaveStatus,
  type SaveStatus,
} from "@/lib/noteSaver";
import { useAppStore } from "@/lib/store";
import { usePalette, useScheme } from "@/lib/theme";

// Index pages are generated tables the web app rebuilds; it opens them read-only too.
const READ_ONLY_TYPES = new Set<DbDocument["doc_type"]>([
  "daily_parent",
  "quick_note_parent",
]);

const STATUS_ICON: Record<SaveStatus, SFSymbol> = {
  saved: "checkmark.icloud",
  pending: "icloud",
  saving: "arrow.trianglehead.2.clockwise.rotate.90.icloud",
  error: "exclamationmark.icloud",
  conflict: "exclamationmark.triangle",
};

type Loaded = { doc: DbDocument; revision: string };

export default function NoteScreen() {
  const router = useRouter();
  const palette = usePalette();
  const scheme = useScheme();
  const openDocId = useAppStore((s) => s.openDocId);
  const canGoBack = useAppStore((s) => s.backStack.length > 0);
  const goBack = useAppStore((s) => s.goBack);
  const followLink = useAppStore((s) => s.followLink);
  const patchDocMeta = useAppStore((s) => s.patchDocMeta);
  const status = useSaveStatus((s) =>
    openDocId ? s.byDoc[openDocId] : undefined,
  );

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const editorRef = useRef<NoteEditorHandle>(null);

  const showCopy = useCallback((doc: DbDocument) => {
    trackLoaded(doc.id, doc.updated_at);
    setLoaded({ doc, revision: doc.updated_at });
  }, []);

  // Bumped by "Try again" to re-run the load effect for the same note.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!openDocId) return;
    let cancelled = false;
    fetchDocument(openDocId).then(
      (doc) => {
        if (cancelled) return;
        setLoadError(doc ? null : "This note no longer exists.");
        if (doc) showCopy(doc);
      },
      (err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openDocId, attempt, showCopy]);

  // Foreground: adopt a newer server copy, unless this device has edits in
  // flight — those go through the save path, which detects the conflict.
  // Background: push any unsent edit before the app is suspended.
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      const id = useAppStore.getState().openDocId;
      if (state !== "active") {
        editorRef.current?.flush();
        flushAll();
        return;
      }
      if (!id || hasUnsaved(id)) return;
      try {
        const doc = await fetchDocument(id);
        if (doc && doc.updated_at !== baseVersion(id) && !hasUnsaved(id))
          showCopy(doc);
      } catch {
        // Offline; keep showing what we have.
      }
    });
    return () => sub.remove();
  }, [showCopy]);

  useEffect(() => {
    setSaveHandlers({
      onSaved: (row) => patchDocMeta(row.id, { updated_at: row.updated_at }),
      onConflict: (docId, current) => {
        Alert.alert(
          "Edited on another device",
          `“${current.title || "Untitled"}” changed somewhere else while you were editing. Your latest edits aren’t saved yet.`,
          [
            {
              text: "Load Latest",
              onPress: () => {
                const doc = resolveUseTheirs(docId);
                if (doc && useAppStore.getState().openDocId === docId)
                  showCopy(doc);
              },
            },
            {
              text: "Overwrite with Mine",
              style: "destructive",
              onPress: () => resolveKeepMine(docId),
            },
          ],
        );
      },
    });
  }, [patchDocMeta, showCopy]);

  // `loaded` can briefly be the previous note while the next one fetches; the
  // editor stays mounted (one web view for the app) under a spinner meanwhile.
  const doc = loaded && loaded.doc.id === openDocId ? loaded.doc : undefined;
  const isMoodboard = doc?.doc_type === "moodboard";
  const editable = !!doc && !READ_ONLY_TYPES.has(doc.doc_type);

  return (
    <View style={[styles.fill, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          title: doc ? doc.title || "Untitled" : openDocId ? "" : "Notes",
        }}
      />
      {canGoBack && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="chevron.backward"
            accessibilityLabel="Back"
            onPress={goBack}
          />
        </Stack.Toolbar>
      )}
      {doc && (
        <Stack.Toolbar placement="right">
          {status && status !== "saved" && (
            <Stack.Toolbar.Button
              icon={STATUS_ICON[status]}
              accessibilityLabel={`Save status: ${status}`}
              onPress={() => status === "error" && retry(doc.id)}
            />
          )}
          {focused && (
            <Stack.Toolbar.Button
              variant="done"
              onPress={() => editorRef.current?.blur()}
            >
              Done
            </Stack.Toolbar.Button>
          )}
        </Stack.Toolbar>
      )}

      {!openDocId ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: palette.text }]}>
            No note open
          </Text>
          <Pressable onPress={() => router.navigate("/root")}>
            <Text style={styles.link}>Browse notes</Text>
          </Pressable>
        </View>
      ) : loadError && !doc ? (
        <View style={styles.center}>
          <Text style={{ color: palette.muted }}>{loadError}</Text>
          <Pressable onPress={() => setAttempt((n) => n + 1)}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      ) : !loaded ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : isMoodboard ? (
        <View style={styles.center}>
          <Text style={{ color: palette.muted }}>
            Moodboards open on desktop.
          </Text>
        </View>
      ) : (
        <View style={styles.fill}>
          <NoteEditor
            ref={editorRef}
            docId={loaded.doc.id}
            revision={loaded.revision}
            initialContent={loaded.doc.content}
            editable={editable}
            colorScheme={scheme}
            onChangeContent={async (docId, content) => enqueue(docId, content)}
            onOpenDoc={async (docId) => followLink(docId)}
            onFocusChange={async (next) => setFocused(next)}
            dom={{
              style: styles.fill,
              hideKeyboardAccessoryView: true,
              contentInsetAdjustmentBehavior: "automatic",
            }}
          />
          {!doc && (
            <View
              style={[
                StyleSheet.absoluteFill,
                styles.center,
                { backgroundColor: palette.background },
              ]}
            >
              <ActivityIndicator />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },
  emptyTitle: { fontSize: 17, fontWeight: "600" },
  link: { fontSize: 17, color: "#0a84ff" },
});
