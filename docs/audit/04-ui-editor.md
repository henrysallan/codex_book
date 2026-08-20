# 04 — UI & Editor

**Finding IDs:** `UI-C1` … `UI-L14`. Referenced elsewhere as "UI C1", etc.
**Scope:** `page.tsx`, editor, sidebar, tabs, panels, dashboard widgets, search/palette, database
block, file viewer, moodboard, annotations. Line refs include the two uncommitted diffs (evaluated at
the end).

---

## 1. SPEC

### 1.1 Component ownership
```
RootLayout → Home (owns command-palette/settings open, chatWidth, ⌘P, chat drag-resize)
├─ Sidebar (DndContext, multi-select Set, expanded/rename/ctx-menu state, collapsed persisted)
│  └─ DraggableDocItem (recursive) / FolderItem (recursive) / DriveFolder (lazy)
├─ EditorPanel (center routing hub)
│  ├─ TabBar · Dashboard(+widgets) · FileViewer(dyn) · MoodboardCanvas(dyn)
│  └─ DocumentEditor (key=document.id → full remount per doc)
│     └─ BlockNoteView · toolbar/side-menu/slash/@ menus · NoteSettingsButton · annotations · DB blocks
├─ ChatPanel (ALWAYS MOUNTED; hidden via width:0/opacity:0)
├─ CommandPalette (⌘P) · SettingsModal
```
Dead/unmounted: `SearchDialog.tsx`, `NotionImport.tsx`, `blocksToMarkdown.ts` (all imported nowhere),
`src/app/pdf-test/*` (a **live route** — see UI-L1).

### 1.2 Save/sync state machine (content only, per editor mount)
```
synced ──(change)──▶ pending ──(1s idle)──▶ saving
  saving ─OK→ (backlink sync; 30s index timer) → synced
  saving ─throw→ error (red dot; retries only on next edit)
```
Timers are **cleared, not flushed** on unmount ([DocumentEditor.tsx:700-710](../../src/components/DocumentEditor.tsx#L700-L710)).
Title/subtitle save on blur; tags/settings save immediately. The dot is **content-only**. MoodboardCanvas
has the correct machine (2s debounce, in-flight guard, dedup, **flush on unmount**).

### 1.3 Keyboard shortcuts
⌘P palette (fires even in inputs; no toggle-close) · ⌘⇧F search (listener in SearchBar, **dead on
moodboard tabs** which unmount it) · Escape (clears sidebar select / closes palette,ctx menus,
popovers — but **not** SettingsModal or the delete-confirm modal) · Enter (blur title/subtitle, add
tag, send chat, commit rename/cell) · ⌘/Shift+click sidebar multi-select · `/` `@` menus. **No**
shortcuts for toggle-chat, toggle-sidebar, save, close-tab, or next/prev-tab.

---

## 2. Findings

### CRITICAL

**UI-C1 — Debounced content save is cancelled, not flushed, on unmount → real data loss on every
tab/doc switch.** Because `EditorPanel` mounts `DocumentEditor` with `key={activeDocument.id}`, every
doc switch, tab close, Home click, pageLink/citation click, or delete unmounts the editor; the cleanup
`clearTimeout`s the 1s debounce without saving
([DocumentEditor.tsx:700-710](../../src/components/DocumentEditor.tsx#L700-L710)). Anything typed in
the last ≤1s is discarded, and `_documentCache` still holds the stale content so switching back shows
the loss. *Fix:* flush (immediate save with `editor.document`) in cleanup, as MoodboardCanvas already
does. Pairs with [DATA-C4](02-data-layer.md).

**UI-C2 — No `beforeunload` handling anywhere → data loss on window close / refresh.** Zero
`beforeunload` listeners in `src/`. Closing while `pending`/`saving` loses the edit; same for
moodboards (≤2s) and PDF note text (≤500ms). *Fix:* a `pending/saving → preventDefault` guard plus a
`sendBeacon` flush closes this and UI-C1.

**UI-C3 — Sidebar drag-and-drop can create parent/child cycles; the affected documents vanish from the
tree.** Doc-onto-own-descendant checks only `docId===parentId` ([Sidebar.tsx:361-366](../../src/components/Sidebar.tsx#L361-L366));
folder-onto-a-doc-inside-itself has no descendant check; **multi-drag has no cycle checks at all**.
With `A.parent=B, B.parent=A`, `buildFolderTree`/`getRootDocuments` skip both docs everywhere → they
disappear from the sidebar entirely (still in DB, reachable only via search). A folder-into-own-doc
cycle removes the whole subtree or recurses infinitely in rendering. *Fix:* `isAncestor` walk before
every `setParentDocument`/`moveFolder`, including the multi path.

**UI-C4 — Delete-folder dialog lies.** Modal says "Documents inside will be moved to root"
([Sidebar.tsx:703](../../src/components/Sidebar.tsx#L703)); the backend **recursively deletes** every
descendant folder, document, and sub-note ([db.ts:156-206](../../src/lib/db.ts#L156-L206)) with no
undo. *Fix:* make the dialog tell the truth, or make the backend actually move docs to root. See
[DATA-M8](02-data-layer.md).

### HIGH

**UI-H1 — "Add to context" sends empty content for every non-active document (and whole folders).**
`fetchDocuments` strips content to `"[]"` ([db.ts:227-231](../../src/lib/db.ts#L227-L231));
`resolveDoc` reads that same array (`content: cached?.content`), so every context chip except the
active doc resolves to `"[]"`, and folder chips fan out empty. The server treats any truthy `content`
as client-provided and **skips the DB fetch** (`if (ci.content)` at chat/route.ts:227-233), so the
fallback never triggers. **CONTEXT-tier answers are generated from blank documents** — confidently
wrong "I don't see anything about that." *Fix:* treat `content==="[]"` (or `length<=2`) as missing in
`resolveDoc` or the route. This breaks the app's headline feature; treat as effectively critical.

**UI-H2 — Race between doc switching and background refresh corrupts cache / resurrects docs.** The
non-cached `setActiveTab` sets state **unconditionally after an await** with no `activeDocumentId`
guard ([store.ts:495-501](../../src/lib/store.ts#L495-L501)) — "Close All" can re-activate a closed
document with zero tabs open. The cached path's background refresh overwrites `_documentCache` with
content read *before* the user's first debounced save committed → edits appear lost. *Fix:* guard the
set with an `activeDocumentId` check; version-token the background refresh. Pairs with [DATA-C3](02-data-layer.md).

**UI-H3 — Right-click on a nested child document targets its PARENT — "Delete" destroys the parent and
its subtree.** In the `DraggableDocItem` recursion, child rows receive the parent's own context-menu
closure ([Sidebar.tsx:1252-1255](../../src/components/Sidebar.tsx#L1252-L1255)), which sets
`contextMenu.id = parentDoc.id`. So on any doc nested under another doc, Rename/Add-to-context/Delete
all hit the parent — and delete recursively extends to all its children. (Docs inside *folders* are
fine — they route through `onContextMenuDoc`.) *Fix:* pass the child's own closure. One-line, prevents
a destructive mis-target.

**UI-H4 — Closing the active tab when the fallback tab is a Drive file breaks navigation and throws.**
`closeTab` calls `setActiveTab(lastTab.documentId)` for any tab; for a `drive:<id>` tab there's no
cache entry, so `fetchDocument("drive:…")` runs `.eq("id","drive:…")` → Postgres UUID parse error →
un-caught rejection, and `activeDocumentId` keeps pointing at the *closed* doc (tab gone, editor
stays). *Fix:* branch drive tabs in `closeTab` (mirror `openDriveFile`).

**UI-H5 — 30-second AI-index debounce is cancelled on unmount → documents silently never re-indexed.**
Cleanup clears `indexTimeoutRef` with no flush; the timer is armed only after a successful save. Edit
a note, switch within 30s → `/api/ai/index` never fires, and `index_status` stays `indexed` so backfill
skips it. Staleness accumulates, degrading exactly the retrieval this app is built on. *Fix:* flush on
unmount (fire-and-forget is safe) or schedule indexing server-side on save. Pairs with [AI-H8](03-ai-subsystem.md).

### MEDIUM

**UI-M1 — Editor header never syncs with external changes; blur can revert a rename.** `useState(document.title)`
is captured at mount and never reconciled (same key → no remount). Rename an open doc from the sidebar
→ editor still shows the old title; clicking into the title field and blurring writes the **stale title
back**, reverting the rename.

**UI-M2 — Note settings write to the DB on every keystroke / slider tick.** `handleSettingsChange`
saves synchronously; the font input fires per character and the range input per tick → dozens of
UPDATEs per slider drag, each rewriting `activeDocument` + cache (whole-subtree re-render). *Fix:*
debounce.

**UI-M3 — BacklinksPanel refetches two queries after every autosave.** Effect deps include the whole
`activeDocument` object ([BacklinksPanel.tsx:44](../../src/components/BacklinksPanel.tsx#L44)); every 1s
save replaces it → a round-trip per second while typing. *Fix:* depend on `activeDocument?.id`.

**UI-M4 — localStorage persistence can skip states.** The single 300ms subscribe timer compares only
the last `(state, prev)` pair; a `_dbDocuments` change followed within 300ms by a `chatMessages` change
never persists the doc diff. (Same root as [DATA-M5](02-data-layer.md).)

**UI-M5 — Sidebar renders the whole tree on any interaction.** `FolderItem`/`DraggableDocItem` are
unmemoized and receive ~15 fresh inline closures per row; any Sidebar state change (select, ctx menu,
rename, every dnd-kit over-state during a drag) re-renders every visible row. Sidebar also subscribes
to the entire `_dbDocuments` array only for a delete-dialog name lookup. *Fix:* `React.memo` +
stable callbacks; `getState()` for the lookup. (Note: full tree *rebuilds* per keypress do **not**
happen — the cost is React re-render, not tree construction.)

**UI-M6 — Every autosave re-renders the editor pane; annotations measure the DOM on every keystroke.**
(a) Each save replaces `activeDocument` → re-runs `JSON.parse(document.content)` on the whole doc on
every render (used only at mount — wrap in `useMemo`). (b) `AnnotationMarkers`' MutationObserver
watches the entire editor subtree for `data-id/style/class`, which ProseMirror mutates constantly →
each keystroke triggers rAF → `getBoundingClientRect` per annotation → `setMarkers`. Same in
`FloatingAnnotationChat`.

**UI-M7 — ChatPanel's AbortController is dead machinery.** Created and passed as `signal` but
`.abort()` is never called; no Stop button, no unmount cleanup (the panel never unmounts). A runaway
TIER2 generation can only be waited out. Contrast `AnnotationChat`, which aborts on close. (Server side
= [AI-H1](03-ai-subsystem.md).)

**UI-M8 — PDF note text loses the last ≤500ms on popover close.** `onUpdateNote` is debounced 500ms
with no flush; clicking the backdrop unmounts the popover, dropping the timer.

**UI-M9 — TabBar back/forward disabled states can be stale; history navigates to tab-less docs.**
`canGoBack`/`canGoForward` are called during render but the component doesn't subscribe to
`navHistory`/`navIndex`, so Back can stay visually disabled when it shouldn't. Nav history also keeps
entries for closed tabs (→ renders a doc with no tab pill), and drive tabs never enter history.

**UI-M10 — Optimistic store deletes diverge from recursive backend deletes.** `deleteDocument` removes
only the one doc locally while the backend recursively deletes children → nested sub-notes remain as
ghosts (open → null → silent no-op) until the next `initialize()`. Neither delete closes open tabs of
victims.

**UI-M11 — `initialize()` re-runs on every Supabase auth token refresh.** `onAuthStateChange` fires
TOKEN_REFRESHED (~hourly) with a fresh `user` object; `page.tsx` has `user` in deps → full refetch +
`_dbDocuments` replacement + tab re-validation mid-typing/mid-drag. *Fix:* key the effect on `user?.id`.

**UI-M12 — Database rows: deleting a row orphans its document; aborted creations leak "Untitled" docs.**
`deleteRow` only edits block props — the backing document stays in the sidebar forever. Slash-menu
"Database"/"New page" create the document *before* inserting the block → an error/undo strands an
"Untitled" doc at root.

**UI-M13 — Column width persistence only works if the mouse releases exactly on the handle.**
`onResizeEnd` is wired to the handle's `onMouseUp`; drags usually end elsewhere, so the width is never
written to block props and snaps back on reload.

**UI-M14 — Accessibility: no modal semantics anywhere.** No `role="dialog"`/`aria-modal`/focus trap/
focus restoration in SettingsModal, CommandPalette, the delete-confirm modal, or NotionImport;
SettingsModal and delete-confirm don't even close on Escape. Many icon-only buttons lack `aria-label`
(tab close, tag remove, gear/toggles, PDF color dots, chat send, sidebar +/folder/trash). The Home
pill and DriveFolder rows are clickable `div`s, not keyboard-operable. (The new `IconTooltipButton`
*does* set `aria-label` — good precedent.)

**UI-M15 — FileViewer renders every PDF page eagerly.** `Array.from({length:numPages})` mounts all
pages with text layers at once — a 300-page PDF locks the tab. `renderedPages` tracking exists but
isn't used to defer. *Fix:* windowing/virtualization.

### LOW (selected)

`UI-L1` **`/pdf-test` is a live production route** that loads arbitrary user-supplied PDF URLs,
rendered outside the auth gate — delete or dev-gate. `SearchDialog.tsx`/`NotionImport.tsx`/
`blocksToMarkdown.ts` are dead weight. `UI-L2` CommandPalette fuzzy scorer is broken (`matched` always
true; matches out-of-order) — reuse SearchBar's correct `fuzzyScore`. `UI-L3` model picker has no
outside-click/Escape close. `UI-L4` annotation highlight is baked into content and never removed on
delete. `UI-L5` one annotation per block (dedup on blockId). `UI-L6` share-link toggle failure is an
unhandled rejection (no `catch`). `UI-L7` full context payloads (incl. content) logged on every chat
send. `UI-L8` unguarded setState-after-unmount in FileViewer/chat. `UI-L9` store `subscribe` never
unsubscribed (HMR leak); `cacheWrite` swallows quota silently. `UI-L10` TabBar mutates store state
directly (Home never enters nav history). `UI-L11` fixed-position menus can render off-screen (no
viewport clamp). `UI-L12` Sidebar Escape handler is global (cancels rename *and* clears selection).
`UI-L13` `handleDownload` revokes the object URL synchronously after `.click()` (races the download).
`UI-L14` ⌘P fires while modals are open and while typing.

---

## 3. The uncommitted diff (evaluated)

- **DocumentEditor.tsx (tags row restyle):** correct. The `calc(var(--note-font-size,16px)*0.8125)`
  sizing reads the variable set on the ancestor wrapper, so tags now scale with the per-note font-size
  setting; `min-w-0` + `items-start` fix wrapping. No functional risk. Nit: pill `bg-white` is
  hardcoded (pre-existing).
- **Sidebar.tsx (collapsed-rail chat/settings buttons):** functionally correct — `toggleChat`,
  `isChatOpen`, `onOpenSettings` already in scope; `h-full`+spacer pins the group to the bottom;
  `aria-label` present. **Minor bug:** `IconTooltipButton`'s tooltip renders centered *above* the
  button inside the 40px-wide rail container that has `overflow-hidden`, so in collapsed mode the
  "AI Chat"/"Settings" tooltips are clipped to a sliver. *Fix:* portal the tooltip or flip it to the
  right side when collapsed.

---

## 4. UX / consistency notes

1. **Silent optimistic failures everywhere** — create/rename/delete/move all end in
   `.catch(console.error)`; failed writes appear to succeed then "undo themselves" next session. No
   toast/error surface exists except the editor's red dot and DriveFolder's inline error (a good
   example to copy).
2. **Three names for one product** — title "Codex", sidebar "Book", chat persona "Cortex", PDF chat
   "Codex", storage keys `cortex:*`. Pick one.
3. **Chat history is ephemeral and errors are impersonated** — messages live only in memory; failures
   are appended as a fake assistant message indistinguishable from a real reply, and pollute the next
   turn's history.
4. **Save feedback is content-only** — title/subtitle/tags/settings/moodboard writes give zero
   feedback; the app knows `syncStatus==='pending'` and still says nothing before losing data.
5. **Dashboard/editor divergence** — toggling a todo in the widget doesn't update an open Todo tab and
   vice-versa; `initDashboard` refetches+resyncs on every Home visit with no error surface.
6. **Inconsistent delete confirmations** — sidebar docs/folders confirm; annotations, PDF annotations,
   and database rows delete instantly and irreversibly.
7. **Drive token expiry** has no re-auth prompt — loads just fail with a raw error string.
