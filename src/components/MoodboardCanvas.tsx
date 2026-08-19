"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import { Tldraw, Editor, TLEditorSnapshot } from "tldraw";
import "tldraw/tldraw.css";
import { Document } from "@/lib/types";
import { fetchMoodboardState, saveMoodboardState } from "@/lib/db";

interface MoodboardCanvasProps {
  document: Document;
}

export function MoodboardCanvas({ document: doc }: MoodboardCanvasProps) {
  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);       // true while a save is in-flight
  const dirtyRef = useRef(false);        // true if changes arrived during an in-flight save
  const lastSavedRef = useRef<string>(""); // JSON of last successfully saved snapshot (dedup)
  const [initialSnapshot, setInitialSnapshot] = useState<TLEditorSnapshot | null | undefined>(undefined);
  const [syncStatus, setSyncStatus] = useState<"synced" | "pending" | "saving" | "error">("synced");

  // Load saved snapshot on mount
  useEffect(() => {
    let cancelled = false;
    fetchMoodboardState(doc.id)
      .then((state) => {
        if (cancelled) return;
        if (state?.tldraw_snapshot) {
          setInitialSnapshot(state.tldraw_snapshot as TLEditorSnapshot);
        } else {
          setInitialSnapshot(null); // no saved state — render empty canvas
        }
      })
      .catch((err) => {
        console.error("[Moodboard] failed to load state:", err);
        if (!cancelled) setInitialSnapshot(null);
      });
    return () => { cancelled = true; };
  }, [doc.id]);

  // Use a ref to break the circular dep between doSave ↔ scheduleSave
  const scheduleSaveRef = useRef<() => void>(() => {});

  // Core save function (no debounce, just the write)
  const doSave = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    // Only save the document store — skip session (camera/viewport) to shrink payload
    const snapshot = editor.getSnapshot();
    const payload = { document: snapshot.document };
    const json = JSON.stringify(payload);

    // Skip if identical to last successful save
    if (json === lastSavedRef.current) {
      setSyncStatus("synced");
      return;
    }

    savingRef.current = true;
    setSyncStatus("saving");
    try {
      await saveMoodboardState(doc.id, payload);
      lastSavedRef.current = json;
      setSyncStatus("synced");
    } catch (err) {
      console.error("[Moodboard] save failed:", err);
      setSyncStatus("error");
    } finally {
      savingRef.current = false;
      // If changes came in while we were saving, schedule another save
      if (dirtyRef.current) {
        dirtyRef.current = false;
        scheduleSaveRef.current();
      }
    }
  }, [doc.id]);

  // Debounced save — skips if a save is already in-flight
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    if (savingRef.current) {
      // A save is in-flight — just mark dirty so we re-save after it finishes
      dirtyRef.current = true;
      setSyncStatus("pending");
      return;
    }

    setSyncStatus("pending");
    saveTimerRef.current = setTimeout(() => {
      doSave();
    }, 2000);
  }, [doSave]);

  // Keep ref in sync
  scheduleSaveRef.current = scheduleSave;

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      // Flush any pending save immediately on unmount
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const editor = editorRef.current;
        if (editor) {
          const snapshot = editor.getSnapshot();
          const payload = { document: snapshot.document };
          saveMoodboardState(doc.id, payload).catch(console.error);
        }
      }
    };
  }, [doc.id]);

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      // Load the saved snapshot into the editor.
      // We only persist { document } (no session/camera) to keep the payload small.
      // loadSnapshot accepts a partial snapshot — missing session fields are fine.
      if (initialSnapshot) {
        try {
          editor.loadSnapshot(initialSnapshot);
        } catch (err) {
          console.error("[Moodboard] failed to load snapshot into editor:", err);
        }
      }

      // Listen for store changes to trigger debounced save
      const unsub = editor.store.listen(
        () => scheduleSave(),
        { source: "user", scope: "document" }
      );

      return () => {
        unsub();
      };
    },
    [scheduleSave, initialSnapshot]
  );

  // Show loading while we fetch saved state
  if (initialSnapshot === undefined) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
        Loading canvas…
      </div>
    );
  }

  const dotColor =
    syncStatus === "synced"
      ? "#22c55e"
      : syncStatus === "error"
        ? "#ef4444"
        : "#eab308";

  const dotTitle =
    syncStatus === "synced"
      ? "All changes saved"
      : syncStatus === "error"
        ? "Error saving changes"
        : syncStatus === "saving"
          ? "Saving…"
          : "Unsaved changes";

  return (
    <div className="h-full w-full relative moodboard-canvas" style={{ minHeight: 0 }}>
      <style>{`.moodboard-canvas .tl-watermark_SEE-LICENSE { display: none !important; }`}</style>

      {/* Sync status dot */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 500,
          pointerEvents: "none",
        }}
      >
        <span
          title={dotTitle}
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: dotColor,
            transition: "background-color 0.3s ease",
            pointerEvents: "auto",
          }}
        />
      </div>

      <Tldraw
        licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY}
        onMount={handleMount}
        autoFocus
      />
    </div>
  );
}

export default MoodboardCanvas;
