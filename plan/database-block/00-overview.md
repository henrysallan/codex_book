# Database Block — Implementation Overview

## Goal

Add an **inline database block** to the Cortex editor. A "database" is a custom
BlockNote block type that renders as a TanStack Table instance directly inside a
document. All schema (column definitions) and row data live as JSON within the
block's props — no separate Supabase tables for v1.

## Why this approach?

| Alternative                        | Pros                           | Cons                                              |
| ---------------------------------- | ------------------------------ | ------------------------------------------------- |
| Separate "database document" pages | Full Notion-style databases    | Massive scope: views, relations, rollups, etc.     |
| Lightweight `<table>` block        | Simple                         | No column types, no sorting, no reordering         |
| **Custom block + TanStack Table**  | Rich UX, self-contained, incremental | Data lives in document JSON — fine for ≤1 000 rows |

## Architecture at a glance

```
┌──────────────────────────────────────────────────┐
│  BlockNote Editor                                │
│  ┌────────────────────────────────────────────┐  │
│  │  database block  (createReactBlockSpec)     │  │
│  │  props: { columns: JSON, rows: JSON }      │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  <DatabaseTable />                   │  │  │
│  │  │  useReactTable + @dnd-kit            │  │  │
│  │  │  ┌──────┬──────┬──────┬──────┐      │  │  │
│  │  │  │ Name │ Tags │ Date │ Done │      │  │  │
│  │  │  ├──────┼──────┼──────┼──────┤      │  │  │
│  │  │  │ ...  │ ...  │ ...  │  ☑   │      │  │  │
│  │  │  └──────┴──────┴──────┴──────┘      │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Scope (v1)

### In scope
- Custom `database` block type via `createReactBlockSpec`
- Column types: **text**, **number**, **select**, **checkbox**, **date**
- Inline cell editing (click-to-edit, blur-to-save)
- Column add / remove / rename
- Column reorder via drag-and-drop (@dnd-kit — already installed)
- Column resize
- Row add / delete
- Sort by column (client-side via TanStack)
- Slash menu command `/database` to insert
- Persistence: block props auto-saved via existing `saveDocument` flow

### Out of scope (v2+)
- Separate database page / "linked views"
- Relations between databases
- Rollup / formula columns
- Filter UI
- Row reorder / drag
- Pagination (not needed at <1 000 rows)
- Server-side sort/filter

## New dependency

```
@tanstack/react-table  ^8.x
```

`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` are already in `package.json`.

## File map (new & modified)

| File                                         | Status   | Purpose                                              |
| -------------------------------------------- | -------- | ---------------------------------------------------- |
| `src/lib/databaseBlock.tsx`                  | **new**  | `createReactBlockSpec` for the `database` block       |
| `src/components/DatabaseTable.tsx`           | **new**  | Main table component (useReactTable + DnD)            |
| `src/components/database/DatabaseHeader.tsx` | **new**  | Sortable header cell (drag handle + resizer)          |
| `src/components/database/DatabaseCell.tsx`   | **new**  | Sortable cell with inline editing                     |
| `src/components/database/ColumnMenu.tsx`     | **new**  | Column header dropdown (rename, type, delete)         |
| `src/components/database/AddColumnButton.tsx`| **new**  | "+" button to append a new column                     |
| `src/lib/databaseTypes.ts`                   | **new**  | TypeScript types for columns, rows, cell values       |
| `src/lib/editorSchema.ts`                    | modified | Register `database` block spec in schema              |
| `src/components/DocumentEditor.tsx`          | modified | Add `/database` slash menu item                       |
| `src/app/globals.css` (or Tailwind inline)   | modified | Table cell/resizer/drag-handle styles                 |

No Supabase migration needed — data is stored inline in the document's `content` JSON.

## Plan documents

| Doc                                    | Contents                                        |
| -------------------------------------- | ----------------------------------------------- |
| [01-data-model.md](./01-data-model.md) | Column/row JSON shape, TypeScript types          |
| [02-block-spec.md](./02-block-spec.md) | BlockNote `createReactBlockSpec` implementation  |
| [03-table-component.md](./03-table-component.md) | `DatabaseTable` + header/cell sub-components |
| [04-column-types.md](./04-column-types.md) | Per-type cell renderers & editors            |
| [05-integration.md](./05-integration.md) | Schema, slash menu, styles, save flow          |
| [06-implementation-steps.md](./06-implementation-steps.md) | Ordered implementation checklist |
