import type { DbDocument } from "@cortex/types";
import { AppState } from "react-native";
import { create } from "zustand";

import { StaleWriteError, requestIndex, saveDocumentContent } from "./api";

/**
 * Save pipeline for note bodies, keyed by document so a flush that lands after
 * switching notes still saves to the right row with the right base version.
 *
 * Per document: one save in flight at a time; edits made meanwhile coalesce
 * into the next save. Every save is guarded by the `updated_at` this client
 * last saw (see saveDocumentContent). A rejected save parks the document as
 * `conflict` until the user picks a side — nothing is written in between.
 */

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

type DocState = {
  base: string;
  pending: string | null;
  inFlight: boolean;
  conflict: { current: DbDocument } | null;
  timer: ReturnType<typeof setTimeout> | null;
  indexTimer: ReturnType<typeof setTimeout> | null;
};

type Handlers = {
  onSaved?: (row: DbDocument) => void;
  onConflict?: (docId: string, current: DbDocument) => void;
};

const SAVE_DEBOUNCE_MS = 700;
const RETRY_MS = 4000;
/** Matches the web editor: index 30s after the last save. */
const INDEX_DEBOUNCE_MS = 30_000;

export const useSaveStatus = create<{ byDoc: Record<string, SaveStatus> }>(
  () => ({ byDoc: {} }),
);

function setStatus(docId: string, status: SaveStatus) {
  useSaveStatus.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: status } }));
}

const docs = new Map<string, DocState>();
let handlers: Handlers = {};

export function setSaveHandlers(next: Handlers) {
  handlers = next;
}

/** Start (or restart) tracking a document from a freshly loaded copy. */
export function trackLoaded(docId: string, updatedAt: string) {
  const s = docs.get(docId);
  if (s) {
    if (s.timer) clearTimeout(s.timer);
    s.base = updatedAt;
    s.pending = null;
    s.conflict = null;
    s.timer = null;
  } else {
    docs.set(docId, {
      base: updatedAt,
      pending: null,
      inFlight: false,
      conflict: null,
      timer: null,
      indexTimer: null,
    });
  }
  setStatus(docId, "saved");
}

/** True while this device holds edits the server hasn't accepted yet. */
export function hasUnsaved(docId: string): boolean {
  const s = docs.get(docId);
  return !!s && (s.pending !== null || s.inFlight || s.conflict !== null);
}

export function baseVersion(docId: string): string | null {
  return docs.get(docId)?.base ?? null;
}

export function enqueue(docId: string, content: string) {
  const s = docs.get(docId);
  if (!s) return; // never loaded on this device — nothing to compare against
  s.pending = content;
  if (s.conflict) return;
  setStatus(docId, "pending");
  if (s.timer) clearTimeout(s.timer);
  // Backgrounding suspends timers; write immediately while there's still time.
  const delay = AppState.currentState === "active" ? SAVE_DEBOUNCE_MS : 0;
  s.timer = setTimeout(() => void run(docId), delay);
}

/** Save everything pending now (app going to background). */
export function flushAll() {
  for (const [docId, s] of docs) {
    if (s.pending !== null && !s.conflict) {
      if (s.timer) clearTimeout(s.timer);
      void run(docId);
    }
  }
}

/** Retry a document whose last save failed on the network. */
export function retry(docId: string) {
  void run(docId);
}

/** Conflict: drop this device's edits and adopt the server copy. */
export function resolveUseTheirs(docId: string): DbDocument | null {
  const s = docs.get(docId);
  const current = s?.conflict?.current ?? null;
  if (!s || !current) return null;
  trackLoaded(docId, current.updated_at);
  return current;
}

/** Conflict: overwrite the server copy with this device's latest edits. */
export function resolveKeepMine(docId: string) {
  const s = docs.get(docId);
  if (!s?.conflict) return;
  s.base = s.conflict.current.updated_at;
  s.conflict = null;
  void run(docId);
}

async function run(docId: string) {
  const s = docs.get(docId);
  if (!s || s.inFlight || s.conflict || s.pending === null) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;

  const content = s.pending;
  s.pending = null;
  s.inFlight = true;
  setStatus(docId, "saving");

  try {
    const row = await saveDocumentContent(docId, content, s.base);
    s.base = row.updated_at;
    handlers.onSaved?.(row);
    scheduleIndex(docId, s);
  } catch (err) {
    if (err instanceof StaleWriteError) {
      // Keep the newest local body (later edits may have queued meanwhile).
      s.pending = s.pending ?? content;
      s.conflict = { current: err.current };
      setStatus(docId, "conflict");
      handlers.onConflict?.(docId, err.current);
      return;
    }
    console.warn("[save] failed", err);
    s.pending = s.pending ?? content;
    setStatus(docId, "error");
    s.timer = setTimeout(() => void run(docId), RETRY_MS);
    return;
  } finally {
    s.inFlight = false;
  }

  if (s.pending !== null) void run(docId);
  else setStatus(docId, "saved");
}

function scheduleIndex(docId: string, s: DocState) {
  if (s.indexTimer) clearTimeout(s.indexTimer);
  s.indexTimer = setTimeout(() => void requestIndex(docId), INDEX_DEBOUNCE_MS);
}
