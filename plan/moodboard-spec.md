# Cortex Moodboard — Implementation Spec

## Overview

A new note type in Cortex: an infinite-canvas moodboard for collecting and arranging visual references. Single-user per canvas, no collaboration. Built on **tldraw** with persistence to **Supabase** (relational metadata + tldraw store snapshots + compressed asset storage via Supabase Storage).

---

## Architecture

### Stack

| Layer | Technology |
|---|---|
| Canvas engine | tldraw (React) |
| State management | tldraw's built-in store (no Yjs — single-user, no collaboration needed) |
| Persistence | Supabase Postgres (relational metadata + serialized tldraw store snapshot) |
| Asset storage | Supabase Storage (compressed media). Free tier: 1 GB storage, 2 GB bandwidth. Already configured — uses existing `@supabase/supabase-js` client. |
| Compression | Client-side before upload (browser-image-compression for images, no re-encode for video) |

> **Why no Yjs?** The existing Cortex codebase does not use Yjs anywhere. Since moodboards are single-user with no collaboration, tldraw's built-in store serialization (`editor.store.getSnapshot()` / `editor.store.loadSnapshot()`) is sufficient. This avoids adding a new dependency and state management paradigm. Undo/redo is handled by tldraw's built-in history API (`editor.history.undo()` / `editor.history.redo()`).

### Data Flow

```
User drops file onto canvas
  → Client compresses image (skip for video/GIF)
  → Upload compressed asset to Supabase Storage bucket, get back public URL
  → Create tldraw custom shape with asset URL + metadata
  → tldraw store updates
  → Debounced save: serialize tldraw store snapshot + upsert relational rows to Supabase
```

### Integration with Existing Architecture

Cortex uses a **single `documents` table** for all note types, discriminated by a `doc_type` column (current values: `note`, `todo`, `daily_parent`, `daily`, `quick_note_parent`). The app is a **single-page app** — the `EditorPanel` component conditionally renders content based on the active document type (Dashboard, DriveFile viewer, or DocumentEditor).

Moodboards follow this pattern:
- A moodboard is a row in `documents` with `doc_type = 'moodboard'`
- Title, folder placement, tags, sidebar hierarchy — all work via existing document infrastructure
- A companion `moodboard_state` table stores the canvas-specific data (tldraw snapshot, canvas settings)
- `EditorPanel` gains a new branch: when `activeDocument.docType === "moodboard"`, render the `MoodboardCanvas` component instead of `DocumentEditor`

---

## Database Schema

### `documents` table (existing — no migration needed)

Moodboards are stored as regular documents:

| Column | Value for moodboards |
|---|---|
| `doc_type` | `'moodboard'` |
| `content` | `'[]'` (unused — canvas state lives in `moodboard_state`) |
| `title` | User-editable title |
| `folder_id` | Standard folder placement |
| `parent_document_id` | Standard nesting support |

The `DocType` TypeScript union in `types.ts` must be extended:
```ts
export type DocType = "note" | "todo" | "daily_parent" | "daily" | "quick_note_parent" | "moodboard";
```

### `moodboard_state` (new table)

Companion table for canvas-specific data, keyed by the document ID.

| Column | Type | Notes |
|---|---|---|
| `document_id` | `uuid` PK, FK → `documents.id` ON DELETE CASCADE | 1:1 with the document row |
| `tldraw_snapshot` | `jsonb` | Serialized tldraw store snapshot (`editor.store.getSnapshot()`) |
| `canvas_settings` | `jsonb` | Grid type, grid size, snap config, viewport position/zoom |
| `updated_at` | `timestamptz` | Auto-updated on save |

### `moodboard_objects`

Relational representation of every object on the canvas. Kept in sync with the tldraw store on each save.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Matches the tldraw shape ID |
| `moodboard_id` | `uuid` FK → `documents.id` ON DELETE CASCADE | References the moodboard document |
| `type` | `text` | `image`, `gif`, `video` |
| `asset_url` | `text` | Supabase Storage public URL of the compressed asset |
| `original_filename` | `text` | For display/reference |
| `mime_type` | `text` | `image/png`, `video/mp4`, etc. |
| `width` | `float` | Canvas width (tldraw units) |
| `height` | `float` | Canvas height (tldraw units) |
| `x` | `float` | Canvas x position |
| `y` | `float` | Canvas y position |
| `rotation` | `float` | Degrees, default `0` |
| `z_index` | `integer` | Layer order |
| `file_size_bytes` | `integer` | Compressed file size |
| `tags` | `text[]` | Reserved for future tagging system (nullable, unused for now) |
| `metadata` | `jsonb` | Extensible — original dimensions, duration for video, etc. |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

### `moodboard_assets`

Tracks uploaded assets independently of their placement on a canvas. Enables future reuse across moodboards.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK | |
| `storage_path` | `text` | Path within the Supabase Storage bucket (e.g. `{user_id}/moodboard-assets/{asset_id}/{filename}`) |
| `public_url` | `text` | Supabase Storage public URL |
| `original_filename` | `text` | |
| `mime_type` | `text` | |
| `file_size_bytes` | `integer` | After compression |
| `original_size_bytes` | `integer` | Before compression |
| `width_px` | `integer` | Native pixel dimensions |
| `height_px` | `integer` | |
| `duration_ms` | `integer` | For video, nullable |
| `created_at` | `timestamptz` | |

---

## Canvas Engine — tldraw Configuration

### Custom Shape Types

Strip all default tldraw tools (draw, text, eraser, arrow, etc.). Register three custom shape types:

#### `MoodboardImageShape`
- Renders an `<img>` tag inside the shape
- Supports PNG, JPG, WebP
- Aspect ratio preserved on resize (hold Shift to free-resize)
- Displays a subtle border/shadow on hover

#### `MoodboardGifShape`
- Renders an `<img>` tag with the GIF src
- **Autoplays** — no play/pause controls
- Same resize behavior as image

#### `MoodboardVideoShape`
- Renders a `<video>` element with `autoplay={false}`, `controls`, `loop`
- **Plays inline** on the canvas
- Muted by default, click to unmute
- Shows first frame as poster/thumbnail when paused

### Canvas Behavior

| Feature | Behavior |
|---|---|
| Zoom | Scroll wheel / pinch, with min/max bounds (10%–800%) |
| Pan | Space+drag or middle-mouse drag |
| Selection | Click to select, click+drag for marquee |
| Multi-select | Shift+click to add to selection, marquee selects all intersecting |
| Group drag | Drag any selected object, all selected objects move together |
| Resize | Corner/edge handles. Aspect-ratio-locked by default, Shift to unlock |
| Rotation | Not included for v1 (shapes are axis-aligned) |
| Z-ordering | Last clicked object moves to top. No manual bring-to-front/send-to-back UI needed |
| Undo/redo | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Cmd+Z` / `Cmd+Shift+Z`), powered by tldraw's built-in history |

### Snap System

Support two snap modes, toggled via a toolbar control:

| Mode | Behavior |
|---|---|
| **Grid snap** | Objects snap to a regular grid. Grid rendered as dots or lines. |
| **Object snap** | Objects snap to edges and centers of other objects. Snap guides rendered as lines. |

Grid size options: `8px`, `16px`, `32px`, `64px` (default `16px`). Stored in `canvas_settings`.

### Alignment Tools

Toolbar buttons (visible when 2+ objects selected):

- Align left / center / right (horizontal)
- Align top / middle / bottom (vertical)
- Distribute horizontally / vertically (3+ objects)

tldraw has alignment utilities built in — expose them in a minimal toolbar.

### Context Menu

Right-click on an object shows a custom context menu:

| Action | Behavior |
|---|---|
| **Delete** | Remove object from canvas and delete `moodboard_objects` row. Asset in Supabase Storage is NOT deleted (may be referenced elsewhere in future). |

Future context menu items (not implemented now): Copy, Duplicate, Add Tags, Replace Media.

---

## Asset Pipeline

### Upload Flow

Two input methods:

1. **Drag and drop** — files dragged from OS onto the canvas
2. **Paste** — `Ctrl+V` / `Cmd+V` with image data or files on clipboard

Both funnel into the same pipeline:

```
1. Validate file type (PNG, JPG, WebP, GIF, MP4, WebM)
2. Validate file size (reject if over limit — see below)
3. Compress (images only — see compression rules)
4. Upload to Supabase Storage (`moodboard-assets` bucket)
5. Create moodboard_assets row
6. Create tldraw shape at drop position (or center of viewport for paste)
7. Create moodboard_objects row
```

### Compression Rules

| Type | Strategy |
|---|---|
| **PNG** | Convert to WebP at quality 85. If output is larger than input, keep PNG. |
| **JPG** | Re-encode as WebP at quality 85. |
| **WebP** | Re-encode at quality 85 if file > 2MB, otherwise keep as-is. |
| **GIF** | No re-encoding (lossy GIF compression destroys quality). Store as-is. |
| **MP4 / WebM** | No client-side re-encoding. Store as-is. |

Compression runs client-side using `browser-image-compression` (or `canvas` API for WebP conversion). Max dimension cap: resize to fit within `4096×4096` before compression.

### File Size Limits

| Type | Max (after compression) |
|---|---|
| Images | 10 MB |
| GIFs | 20 MB |
| Video | 100 MB |

Show a toast notification if a file exceeds limits after compression.

### Supabase Storage Setup

**Bucket**: `moodboard-assets` (created via Supabase dashboard or migration)

**Path structure**:
```
{user_id}/{asset_id}/{filename}
```

Use the asset UUID as the folder name to avoid collisions. Preserve original filename for readability.

**Access**: Public bucket (assets are served via Supabase's CDN with unguessable paths). No signed URLs needed — simpler for tldraw image rendering.

**Upload method**: Direct client-side upload via `supabase.storage.from('moodboard-assets').upload(path, file)`. No API route needed — the existing Supabase client handles auth and upload. Public URL retrieved via `supabase.storage.from('moodboard-assets').getPublicUrl(path)`.

---

## Persistence Strategy

### Save Trigger

Save on every change, **debounced at 1000ms** (1 second after last change).

### Save Procedure

On each save:

1. Serialize tldraw store: `editor.store.getSnapshot()` → JSON
2. Upsert `moodboard_state.tldraw_snapshot` with the JSON blob
3. Diff the current tldraw shapes against `moodboard_objects`:
   - New shapes → `INSERT` rows
   - Changed shapes → `UPDATE` position/size/z_index
   - Removed shapes → `DELETE` rows
4. Update `moodboard_state.updated_at`

Steps 2–4 run in a single Supabase transaction.

### Load Procedure

On opening a moodboard note:

1. Fetch `moodboard_state.tldraw_snapshot` by `document_id`
2. Initialize tldraw editor
3. Load the snapshot: `editor.store.loadSnapshot(snapshot)`
4. Canvas renders from tldraw store (relational rows are not used for rendering, only for queries)
5. If no `moodboard_state` row exists (new moodboard), initialize with empty canvas

### Undo/Redo

- Powered by tldraw's built-in history API (`editor.history.undo()` / `editor.history.redo()`)
- Tracks all shape additions, deletions, and property changes
- `Ctrl+Z` / `Ctrl+Shift+Z` (or `Cmd+Z` / `Cmd+Shift+Z` on Mac) keybindings
- Undo stack is session-only (not persisted — resets on page reload)

---

## UI Integration with Cortex

### Note Creation

The `+` button in the sidebar header currently calls `createDocument(null)` which hardcodes `doc_type: "note"`. Changes needed:

1. **Store**: `createDocument` gains an optional `docType` parameter (default `"note"`)
2. **Sidebar**: A new button is added **next to** the existing `+` button in the sidebar header:

```
[+] [⊞]  (Plus = new document, LayoutGrid = new moodboard)
```

The `+` button keeps its current behavior (create document). The new `⊞` button (`LayoutGrid` icon from lucide-react) calls `createDocument(null, "moodboard")`.

Creating a moodboard document:
- Inserts a `documents` row with `doc_type: "moodboard"`, `content: "[]"`
- Inserts an empty `moodboard_state` row with `tldraw_snapshot: null`
- Opens the document (same as current flow)

### Sidebar Behavior

- Moodboard notes appear in the sidebar alongside document notes (already handled — they're in the `documents` table)
- Distinguished by an icon: `LayoutGrid` from lucide-react (vs `FileText` for regular docs)
- `DraggableDocItem` component's icon switch gains a `moodboard` branch:
  ```tsx
  doc.docType === "moodboard" ? (
    <LayoutGrid size={13} className="text-muted-foreground shrink-0" />
  ) : ...
  ```
- Title is editable inline in the sidebar, same as document notes
- Drag-and-drop into folders works identically (it's just a document)
- Delete works identically (cascade deletes `moodboard_state` and `moodboard_objects` rows)

### EditorPanel Routing

`EditorPanel` (in `components/EditorPanel.tsx`) currently branches between Dashboard, FileViewer, and DocumentEditor. Add a new branch:

```tsx
// In EditorPanel's render logic:
activeDocument?.docType === "moodboard" ? (
  <MoodboardCanvas key={activeDocument.id} document={activeDocument} />
) : activeDocument ? (
  <>
    <DocumentEditor key={activeDocument.id} document={activeDocument} />
    <BacklinksPanel />
  </>
) : ...
```

When viewing a moodboard:
- No `BacklinksPanel` (moodboards don't have block content to link)
- No `SearchBar` at the bottom
- The AI `ChatPanel` is hidden for now (future integration)

### Canvas Chrome

Minimal toolbar above or overlaying the canvas:

```
[Snap: Grid ▾] [Grid Size: 16px ▾] [Align ▾] [Zoom: 100%] [Undo] [Redo]
```

- **Snap toggle**: Dropdown — `Off`, `Grid`, `Objects`
- **Grid size**: Dropdown — `8`, `16`, `32`, `64`
- **Align**: Dropdown with alignment/distribute actions (disabled when <2 objects selected)
- **Zoom**: Display current zoom, click to reset to 100%
- **Undo/Redo**: Buttons with standard shortcuts

No other toolbars. No shape creation tools — objects are only added via drag-and-drop or paste.

---

## Tagging System (Future — Not Implemented)

The `tags` column on `moodboard_objects` is reserved. When implemented:

- Right-click context menu gains "Add Tags" option
- Tags are freeform text, autocompleted from previously used tags
- Tags enable cross-moodboard search: "show me all objects tagged `typography`"
- Tags are stored as `text[]` in Postgres, indexed with GIN

For now, the column exists but is always `null`. No UI for tags.

---

## AI Integration (Future — Not Implemented)

Not in scope for v1. When implemented:

- AI panel can "see" moodboard contents by serializing `moodboard_objects` rows into context
- Possible features: describe the board, suggest related references, auto-tag, generate mood descriptions
- Would use the existing Cortex RAG pipeline with moodboard object metadata as documents

---

## Implementation Order

### Phase 1 — Plumbing & Canvas Foundation
1. Add `"moodboard"` to the `DocType` union in `types.ts`
2. Update `createDocument` in `db.ts` and `store.ts` to accept an optional `docType` parameter
3. Add moodboard creation button next to `+` in sidebar header
4. Add `LayoutGrid` icon for moodboard docs in `DraggableDocItem`
5. Install `tldraw` package (`npm install tldraw`)
6. Create `MoodboardCanvas` component with basic tldraw setup, strip default tools
7. Add moodboard branch in `EditorPanel` routing
8. Database migration: `moodboard_state`, `moodboard_objects`, `moodboard_assets` tables

### Phase 2 — Custom Shapes & Drop
1. Implement the three custom shape types (image, GIF, video)
2. Basic drag-and-drop + paste upload (no compression yet, placeholder storage)
3. Z-ordering: last-clicked-to-top behavior

### Phase 3 — Supabase Storage & Persistence
1. Create `moodboard-assets` bucket in Supabase Storage (public bucket)
2. Wire up asset upload pipeline (client → `supabase.storage.upload()` → public URL)
3. Implement debounced save (`editor.store.getSnapshot()` → Supabase)
4. Implement load from Supabase on moodboard open (`editor.store.loadSnapshot()`)
5. Sync `moodboard_objects` relational rows on each save

### Phase 4 — Interactions
1. Grid snap + object snap with toggle UI
2. Alignment tools
3. Context menu (delete)
4. Toolbar (snap, grid size, align, zoom, undo/redo)

### Phase 5 — Asset Pipeline Polish
1. Client-side compression (WebP conversion, dimension cap) via `browser-image-compression`
2. File size validation + error toasts
3. Upload progress indicator

---

## New Dependencies

| Package | Purpose |
|---|---|
| `tldraw` | Canvas engine |
| `browser-image-compression` | Client-side image compression before upload |

No `yjs` dependency needed — tldraw's built-in store handles state management.
No new storage SDK needed — `@supabase/supabase-js` (already installed) includes Supabase Storage methods.

---

## Open Questions

- **Supabase Storage limits**: Free tier is 1 GB storage, 2 GB bandwidth/month. For heavy moodboard use with video, this could be tight. Monitor usage and consider upgrading to Pro ($25/mo, 100 GB storage, 200 GB bandwidth) if needed.
- **Supabase Storage RLS**: The `moodboard-assets` bucket should be public (for easy tldraw rendering) but uploads should be restricted via RLS policies so users can only write to their own `{user_id}/` prefix.
- **Thumbnail generation**: Do we want to generate a thumbnail of the moodboard for the sidebar or a future grid view? If so, `html2canvas` or server-side screenshot.
- **Max objects per board**: Should we cap at some number (e.g., 500) for performance? tldraw handles hundreds of shapes well, but video elements could get heavy.
- **Mobile**: Is the moodboard usable on mobile/tablet? tldraw supports touch, but the interaction model (drag-and-drop files) is desktop-first. Decide if mobile is a target or explicitly out of scope.
- **tldraw snapshot size**: For boards with many objects, the JSON snapshot could get large. Monitor and consider whether to compress (e.g., gzip) before storing in the `jsonb` column, or switch to `bytea` if needed.
- **`content` column**: Moodboard documents store `content: "[]"` (unused). This is fine — the full-text search index (`fts` tsvector) will just index the title, which is correct behavior.
- **Asset cleanup**: When a moodboard is deleted, `moodboard_assets` rows are preserved (assets may be reused in future). Consider a periodic cleanup job that deletes orphaned assets from Supabase Storage.
