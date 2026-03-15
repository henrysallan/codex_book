# Database Block — Implementation Steps

Ordered checklist. Each step should result in a building, working state.

---

## Phase 1 — Foundation (get a block rendering)

### Step 1: Install dependency
```bash
cd cortex && npm install @tanstack/react-table
```

### Step 2: Create types file
- **File**: `src/lib/databaseTypes.ts`
- Define `ColumnType`, `DatabaseColumn`, `DatabaseRow`, `CellValue`
- Add `parseColumns()`, `parseRows()` helpers
- Add `coerceValue()` for type-change conversion

### Step 3: Create the block spec
- **File**: `src/lib/databaseBlock.tsx`
- `createReactBlockSpec` with `type: "database"`, `propSchema: { columns, rows }`, `content: "none"`
- Render component wraps `<DatabaseTable />` in a `contentEditable={false}` div
- Skeleton `DatabaseTable` — just renders a `<div>Database block placeholder</div>` for now

### Step 4: Register in schema
- **File**: `src/lib/editorSchema.ts`
- Import `defaultBlockSpecs` from `@blocknote/core`
- Add `database: createDatabaseBlock()` to `blockSpecs`
- Spread `...defaultBlockSpecs` so built-in blocks are preserved

### Step 5: Add slash menu item
- **File**: `src/components/DocumentEditor.tsx`
- Add "Database" item to custom slash menu items
- Uses `editor.insertBlocks` with default column + row

### 🧪 Checkpoint: Type `/database` → a placeholder block appears in the editor. Save works. Build passes.

---

## Phase 2 — Basic table rendering (read-only)

### Step 6: Build `DatabaseTable` component
- **File**: `src/components/DatabaseTable.tsx`
- Parse columns/rows from block props
- Build TanStack `ColumnDef[]` dynamically
- `useReactTable` with `getCoreRowModel` + `getSortedRowModel`
- Render `<table>` with `<thead>` and `<tbody>` using `flexRender`
- Basic Tailwind styling (borders, padding, header background)

### Step 7: Add table CSS
- **File**: `src/app/globals.css`
- Add `.db-table`, `.db-th`, `.db-td`, `.db-resizer` classes

### 🧪 Checkpoint: `/database` inserts a styled table with one "Name" column and one empty row. Data renders correctly.

---

## Phase 3 — Cell editing

### Step 8: Build `CellEditor` component
- **File**: `src/components/database/CellEditor.tsx`
- Switch on column type → render appropriate editor
- Start with `TextCell` only

### Step 9: Wire up cell mutations
- In `DatabaseTable`, implement `updateCell(rowId, colId, value)` callback
- Each cell edit calls `editor.updateBlock` to persist

### Step 10: Add row / delete row
- "+" button in table footer calls `updateRows([...rows, newRow])`
- Row context menu or trash icon calls `updateRows(rows.filter(...))`

### 🧪 Checkpoint: Click a cell → edit text → blur → data persisted. Can add/delete rows.

---

## Phase 4 — Column management

### Step 11: Add column button
- **File**: `src/components/database/AddColumnButton.tsx`
- Renders as a "+" header cell on the right
- Appends a new `DatabaseColumn` (default type: text)

### Step 12: Column header menu
- **File**: `src/components/database/ColumnMenu.tsx`
- Click column header → dropdown with: Rename, Change Type, Delete
- Rename: inline input in header
- Change Type: sub-menu with type options, runs `coerceValue` on all rows
- Delete: removes column from columns array and `colId` key from all row cells

### 🧪 Checkpoint: Can add columns, rename them, change types, delete them.

---

## Phase 5 — Column DnD + resize

### Step 13: Column reorder with @dnd-kit
- **File**: `src/components/database/DatabaseHeader.tsx`
- `useSortable` per header cell (same pattern as reference repo)
- `DndContext` + `SortableContext` in `DatabaseTable`
- `handleDragEnd` reorders the `columns` array and calls `updateColumns`

### Step 14: Column resize
- Header resize handle: `onMouseDown={header.getResizeHandler()}`
- TanStack's `columnResizeMode: "onChange"` handles the width tracking
- On resize end, persist new `width` values to columns array

### 🧪 Checkpoint: Drag columns to reorder. Drag edge to resize. Changes persist.

---

## Phase 6 — Remaining cell types

### Step 15: Number cell
- `<input type="number">`, right-aligned, `parseFloat` on commit

### Step 16: Checkbox cell
- `<input type="checkbox">`, centred, single-click toggle

### Step 17: Select cell
- Pill display with stable colour derived from string hash
- Click → dropdown of `config.options`
- "Add option" at bottom of dropdown

### Step 18: Date cell
- `<input type="date">` with native date picker
- Display formatted date

### 🧪 Checkpoint: All five column types work with editing, display, and sort.

---

## Phase 7 — Polish

### Step 19: Sort UI
- Click header to sort (asc → desc → none)
- Sort indicator arrows in header

### Step 20: HTML export
- `toExternalHTML` on the block spec renders an HTML `<table>`

### Step 21: Empty state
- When the table has 0 rows, show a friendly "No rows yet. Click + to add one."

### Step 22: Focus management
- Tab to move between cells in a row
- Enter to move to the cell below
- Escape to cancel editing

### 🧪 Final checkpoint: Full feature works end-to-end. Build passes. Deploy to Vercel.

---

## Estimated effort

| Phase | Steps | Estimate |
|-------|-------|----------|
| 1. Foundation | 1–5 | 30 min |
| 2. Basic table | 6–7 | 45 min |
| 3. Cell editing | 8–10 | 45 min |
| 4. Column management | 11–12 | 60 min |
| 5. Column DnD + resize | 13–14 | 45 min |
| 6. Cell types | 15–18 | 60 min |
| 7. Polish | 19–22 | 45 min |
| **Total** | **22 steps** | **~5.5 hours** |
