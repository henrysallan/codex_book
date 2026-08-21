# Graph View — Spec

A full-database node graph: every document is a node, folders are visually distinct nodes, backlinks are wires. Opened from a sidebar button, rendered on a canvas that pans with two-finger scroll (or right-click drag) and zooms with pinch. Clicking a node opens the note. The headline requirement is **speed** — instant open, 60fps interaction.

Status: **draft — see Open Questions before building.**

---

## 1. Goals & non-goals

**Goals**

- One button in the sidebar opens a graph of the entire database.
- Notes are circular nodes; folders are visually distinct nodes; wires connect linked documents.
- Wires are smooth curves with a visible gap between the wire endpoint and the node edge.
- Pan: two-finger scroll / trackpad, or right-click drag. Zoom: pinch (and ⌘/ctrl+scroll).
- Click a node → opens that document in the editor.
- Ultrafast: first paint feels instant, interaction never drops frames at realistic scale.

**Non-goals (v1)**

- No editing from the graph (no creating links by dragging, no renaming).
- No graph for shared/public views.
- No mobile/touch-screen support beyond what falls out for free (this is a desktop web feature; the iOS app is separate).

---

## 2. Data model — nothing new to persist

The graph is assembled entirely from data that already exists:

| Graph element | Source | Notes |
|---|---|---|
| Note nodes | `_dbDocuments` already in the store | `id`, `title`, `doc_type`, `folder_id`, `parent_document_id` — no fetch needed |
| Folder nodes | `_dbFolders` already in the store | `id`, `name`, `parent_id`, `parent_document_id` |
| Link wires | `backlinks` table | **One new query**: `listAllBacklinks()` in `db.ts` selecting `source_document_id, target_document_id` (RLS already scopes to the user; local-mode falls back to the existing localStorage backlinks) |
| Containment wires | `folder_id` / `parent_id` / `parent_document_id` | Derived client-side, zero cost |

No migration is required. Node positions are cached per-device in localStorage (`cortex:cache:graphLayout`), following the app's cache-first convention — **not** in the database (see Open Question 7).

**Known data caveat:** backlinks rows are written on save (`syncBacklinks`) and by the importer, but any document that hasn't been edited since the backlinks feature shipped may have missing edges. v1 should include a one-time client-side backfill: if the graph opens and the backlinks table is suspiciously empty relative to `pageLink`/wikilink usage, offer a "Rebuild links" action that runs `parseBacklinks` + `syncBacklinks` across all documents (same path the importer uses).

---

## 3. Architecture

```
Sidebar button ─► store.isGraphOpen = true
                        │
EditorPanel ──► <GraphView/>  (next/dynamic, ssr:false — same pattern as MoodboardCanvas)
                        │
        ┌───────────────┼─────────────────────┐
        │               │                     │
  buildGraph.ts    layout.worker.ts      renderer.ts
  (store rows +    (d3-force sim in a    (Canvas 2D: draw,
   backlinks →      Web Worker, posts     cull, hit-test,
   typed arrays)    Float32Array ticks)   pan/zoom transform)
```

**New files**

- `src/components/GraphView.tsx` — the React shell: canvas element, toolbar, event wiring. Renders imperatively via refs; React re-renders never happen during pan/zoom/sim.
- `src/lib/graph/buildGraph.ts` — assembles nodes/edges from `_dbDocuments`, `_dbFolders`, and `listAllBacklinks()`; outputs typed arrays + an id↔index map.
- `src/lib/graph/layout.worker.ts` — d3-force simulation off the main thread.
- `src/lib/graph/renderer.ts` — pure canvas drawing + quadtree hit-testing. No React imports.

**Touched files**

- `src/lib/db.ts` — add `listAllBacklinks(): Promise<{source: string; target: string}[]>`.
- `src/lib/store.ts` — add `isGraphOpen`, `openGraph()`, `closeGraph()`. `openDocument()` sets `isGraphOpen: false` (see Open Question 3).
- `src/components/EditorPanel.tsx` — branch: `isGraphOpen` renders `GraphView` (takes precedence over dashboard/editor).
- `src/components/Sidebar.tsx` — one icon button (`Waypoints` from lucide, `size={14}`) in the create-actions row next to New document / New moodboard / New folder / Import.

**New dependency:** `d3-force` + `d3-quadtree` only (~30 kB combined, tree-shakeable). Explicitly **not** react-force-graph, sigma.js, or tldraw — see §4.

---

## 4. Rendering: Canvas 2D, one layer, batched

**Why not the alternatives**

- **SVG / DOM nodes** — thousands of DOM elements make pan/zoom churn layout and paint; this is the main reason graph views feel sluggish. Rejected.
- **tldraw** (already in the repo) — DOM-based shapes, editor machinery we don't need; wrong tool for 1k+ nodes. Rejected.
- **WebGL (sigma.js / PixiJS / Cosmograph)** — the right call above ~10k nodes, but adds a heavy dependency and shader complexity. A single-user knowledge base is realistically hundreds to a few thousand notes. Canvas 2D with the techniques below holds 60fps to ~5k nodes / ~15k edges, which is ample headroom. Revisit only if Open Question 9 says otherwise.

**Performance techniques (these are the spec, not suggestions)**

1. **Typed arrays everywhere.** Positions in one `Float32Array` (x,y interleaved), edges as index pairs in a `Uint32Array`. No per-node objects on the hot path.
2. **Simulation in a Web Worker.** d3-force ticks off the main thread; the worker posts the positions buffer as a transferable each animation frame while hot, then goes silent. Main thread never computes layout.
3. **Draw only when dirty.** The rAF loop runs only while (a) the sim is ticking, (b) the user is panning/zooming, or (c) a hover transition is animating. Idle graph = zero CPU.
4. **Batch by style.** All default-style edges in one `beginPath()`/one `stroke()`; nodes batched per fill style. Per-element `stroke()` calls are the classic canvas killer. Highlighted hover state draws in a small second pass.
5. **Viewport culling.** Skip nodes and edges wholly outside the visible rect (cheap AABB check against the current transform). At high zoom this eliminates most of the draw list.
6. **Level of detail.**
   - Labels render only when `zoom × nodeRadius` crosses a threshold, and only for on-screen nodes; they fade in over ~100ms.
   - Below ~0.3 zoom, edges render as straight lines instead of curves and node strokes are skipped.
   - `shadowBlur` is banned (worst canvas perf trap); halos are drawn as a second larger circle.
7. **Hit-testing via d3-quadtree**, rebuilt when the sim settles — never per-pixel color picking, never linear scans on mousemove.
8. **DPR-aware, capped at 2.** Canvas backing store scales with `devicePixelRatio` up to 2; beyond that is invisible cost on retina displays.
9. **Cached layout = instant open.** On open, nodes paint immediately at their cached positions (localStorage) while the worker warm-starts the sim from those positions with low alpha (`0.1`) so the graph settles in place instead of exploding. First-ever open runs a full sim (`alpha 1`) behind a brief "laying out…" shimmer.
10. **No React in the loop.** All interaction mutates refs and redraws the canvas directly. React renders the shell once.

**Budgets** (measured on the dev machine, ~2k nodes / 6k edges):

| Metric | Target |
|---|---|
| Open → first paint (cached layout) | < 150 ms |
| Open → settled layout (cold, 2k nodes) | < 2.5 s, non-blocking |
| Pan / zoom frame time | < 8 ms (comfortable 60fps, headroom for 120Hz) |
| Idle CPU | 0 (no rAF running) |
| Hover hit-test | < 0.5 ms |

**Turbopack/worker risk:** `new Worker(new URL("./layout.worker.ts", import.meta.url))` is the supported pattern in Next 16/Turbopack, but verify early in implementation. Fallback if it misbehaves: run the sim on the main thread in time-sliced chunks (~4 ms per rAF) — acceptable at this scale, just less smooth during initial layout.

---

## 5. Layout

d3-force with:

- `forceLink` over backlink edges (distance ~60, strength scaled down for high-degree nodes so hubs don't collapse their neighborhoods).
- `forceManyBody` (Barnes-Hut, `theta 0.9`) for repulsion.
- Weak `forceX`/`forceY` gravity toward center so disconnected clusters and orphans don't drift to infinity (cheaper than `forceCollide`; add collide only if overlap looks bad under ~1.5k nodes).
- **Containment edges** (folder→child) participate in the sim as short, weak links so folders pull their contents into visible clusters — whether they're also *drawn* is Open Question 2.
- Sim runs until `alpha < 0.005`, then freezes and persists positions to the layout cache (debounced 1s).

---

## 6. Visual design

The graph inherits the app's restrained, monochrome-plus-accents language via the existing CSS theme tokens (read once per theme change with `getComputedStyle` and passed to the renderer — canvas can't use CSS vars natively).

- **Note nodes:** filled circles, radius `3 + 2·√(degree)` clamped to 3–10 px (world units). Fill: `foreground` at reduced opacity; the active document gets an accent ring.
- **Folder nodes:** rounded squares, slightly larger than the mean note node, distinct muted fill — instantly parseable as "not a note" even at far zoom. Doc-type variants (moodboard, daily) can tint subtly later; v1 keeps two shapes only.
- **Wires:** quadratic Bézier curves with a perpendicular control-point offset of ~8% of the endpoint distance — a gentle bow, not a swoop. Each end is **shortened along its tangent by `nodeRadius + 5 px`**, giving the requested air gap between wire and node. ~1 px stroke at `border` color, low opacity so dense regions read as texture rather than mud.
- **Labels:** document titles in the app font, set below the node, appearing per the LOD rule. Folder labels get slightly heavier weight.
- **Hover:** hovered node + its 1-hop neighborhood at full opacity with edges brightened; everything else dims to ~20%. Cursor becomes pointer. Transition ~100 ms.
- **Empty state:** if there are no backlinks at all, show a short explainer + the "Rebuild links" action from §2.

---

## 7. Interaction

| Input | Behavior |
|---|---|
| Two-finger scroll (wheel, no modifier) | Pan by `deltaX/deltaY` |
| Pinch (macOS trackpad → `wheel` with `ctrlKey`; Safari `gesturechange`) | Zoom toward cursor, clamped 0.05×–4× |
| ⌘/ctrl + scroll | Zoom toward cursor (same path as pinch) |
| Right-click drag | Pan; `contextmenu` suppressed only if the pointer actually moved |
| Left-click node | `openDocument(docId)`; folder nodes expand that folder in the sidebar (they have no document to open) |
| Left-drag on empty canvas | Pan (proposed default — Open Question 8) |
| Hover node | Neighborhood highlight + title label regardless of zoom |
| `Esc` | Close graph, return to previous view |
| Double-click empty space | Zoom-to-fit the whole graph |

The wheel handler is attached non-passive with `preventDefault()` so the page never scrolls or triggers browser back-swipe while the graph is open.

---

## 8. Data freshness & lifecycle

- On open: build from the store's in-memory rows (already fresh via `initialize()`), fetch backlinks once. No polling.
- While open: subscribe narrowly to `_dbDocuments` changes (title renames, deletes) and patch nodes in place; a changed backlink set (user edited a note in another tab — rare) is picked up on next open. Good enough for single-user.
- On close: canvas and worker are torn down; positions cached. Reopening warm-starts (§4.9).

---

## 9. Milestones

**v1 — the feature as requested**
1. `listAllBacklinks()` + `buildGraph.ts` + store/EditorPanel/Sidebar wiring.
2. Canvas renderer: nodes, curved gapped wires, labels, culling, LOD, hit-testing.
3. Worker sim + layout cache + warm start.
4. Pan/zoom/click/hover/Esc/zoom-to-fit.
5. Backfill action for pre-feature documents.

**v1.1 — likely fast follows (not in v1 scope)**
- Filter chips: hide orphans, hide dailies/quick notes, per-folder focus.
- Search-in-graph (reuse ⌘P matching, fly-to result).
- Drag nodes with pinning; "focus mode" (n-hop neighborhood of the active doc).
- Tag-based node coloring.

---

## 10. Open questions

Each has a proposed default so implementation isn't blocked — confirm or override.

1. **Which doc types appear?** Daily notes and quick notes can be numerous, tiny, and rarely linked — they may bury the interesting structure. *Proposed: include `note` and `moodboard` by default; `daily`, `quick_note` docs and the system parent docs (`daily_parent`, `quick_note_parent`, `todo`) excluded in v1, toggles in v1.1.*
2. **Are folder containment wires drawn, or only used for clustering?** Drawing them shows the full hierarchy but adds a lot of ink; clustering-only keeps the picture about *links* while folders still visually gather their children. *Proposed: cluster-only, with containment wires drawn faintly on folder-node hover.*
3. **What happens on node click, exactly?** Navigate immediately (graph closes, editor opens), or show a hover preview card first with click-to-open? Immediate navigation is what you described but makes exploration a bit trigger-happy. *Proposed: immediate open; Esc or the sidebar button returns to the graph with position/zoom preserved.*
4. **Placement:** center-panel view (replaces editor/dashboard, chat panel stays usable) or full-screen overlay above everything? *Proposed: center-panel — it keeps the graph a peer of the Dashboard and costs nothing in the shell.*
5. **Direction:** backlinks are directional (A links to B). Show arrowheads / tapered ends, or leave wires undirected? Arrows add clutter fast. *Proposed: undirected in v1; direction shown only in the hover-highlighted state (subtle taper toward the target).*
6. **Node dragging in v1?** Fun, but requires sim reheat + pin bookkeeping. *Proposed: defer to v1.1.*
7. **Layout persistence:** per-device localStorage (proposed, zero backend work) or a DB table so the layout follows you across devices? DB version needs a migration + save path.
8. **Left-drag on empty canvas:** pan (matches every map app; proposed) or reserved for future box-select?
9. **Rough scale check:** about how many documents and links exist today, and what's the realistic ceiling? Canvas 2D is specced for ~5k nodes; if you expect 10k+, v1 should start on WebGL (sigma.js) instead — worth knowing before code is written.
10. **Orphan notes** (no links at all — likely the majority early on): show them in a loose ring around the linked core (proposed), or hide behind a toggle by default?
