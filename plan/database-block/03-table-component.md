# Database Block — Table Component Architecture

## Component tree

```
<DatabaseTable>                    ← src/components/DatabaseTable.tsx
├── <DatabaseToolbar>              ← title row, "+ New column" button
├── <DndContext>                   ← @dnd-kit column reorder wrapper
│   └── <table>
│       ├── <thead>
│       │   └── <SortableContext>
│       │       └── <DatabaseHeader />   ← per-column, sortable + resizable
│       │           └── <ColumnMenu />   ← dropdown: rename, type, delete
│       ├── <tbody>
│       │   └── <tr> per row
│       │       └── <SortableContext>
│       │           └── <DatabaseCell /> ← per-cell, inline editing
│       └── <tfoot>
│           └── <AddRowButton />
└── </DndContext>
```

---

## `DatabaseTable.tsx` (main component)

### Props

```ts
interface DatabaseTableProps {
  block: Block;      // BlockNote block object
  editor: BlockNoteEditor;
}
```

### Internal state

The component parses `block.props.columns` and `block.props.rows` from JSON into
local state on every render. Mutations update BlockNote via `editor.updateBlock`.

```tsx
const columns = useMemo(() => parseColumns(block.props.columns), [block.props.columns]);
const rows    = useMemo(() => parseRows(block.props.rows), [block.props.rows]);
```

### TanStack Table setup

Adapted from the reference repo (`s-d-le/tanstack-react-table-mega-example`):

```tsx
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  ColumnDef,
  SortingState,
  flexRender,
} from "@tanstack/react-table";

// Build TanStack ColumnDefs dynamically from our DatabaseColumn[]
const tanstackColumns: ColumnDef<DatabaseRow>[] = useMemo(
  () =>
    columns.map((col) => ({
      id: col.id,
      accessorFn: (row) => row.cells[col.id] ?? null,
      header: col.name,
      size: col.width,
      meta: { dbColumn: col },   // pass our column metadata through
    })),
  [columns]
);

const [sorting, setSorting] = useState<SortingState>([]);
const [columnOrder, setColumnOrder] = useState<string[]>(columns.map(c => c.id));

const table = useReactTable({
  data: rows,
  columns: tanstackColumns,
  state: { sorting, columnOrder },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  onSortingChange: setSorting,
  onColumnOrderChange: setColumnOrder,
  columnResizeMode: "onChange",
  getRowId: (row) => row.id,
});
```

### Column DnD

Directly mirrors the reference repo pattern:

```tsx
import {
  DndContext, MouseSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove, SortableContext, horizontalListSortingStrategy,
} from "@dnd-kit/sortable";

function handleDragEnd(event: DragEndEvent) {
  const { active, over } = event;
  if (active && over && active.id !== over.id) {
    const oldIdx = columnOrder.indexOf(active.id as string);
    const newIdx = columnOrder.indexOf(over.id as string);
    const newOrder = arrayMove(columnOrder, oldIdx, newIdx);
    setColumnOrder(newOrder);
    // Also reorder the persisted columns array:
    const reordered = newOrder.map(id => columns.find(c => c.id === id)!);
    updateColumns(reordered);
  }
}
```

### Mutation helpers

All mutations go through `editor.updateBlock`:

```tsx
const updateColumns = useCallback((newCols: DatabaseColumn[]) => {
  editor.updateBlock(block, { props: { columns: JSON.stringify(newCols) } });
}, [editor, block]);

const updateRows = useCallback((newRows: DatabaseRow[]) => {
  editor.updateBlock(block, { props: { rows: JSON.stringify(newRows) } });
}, [editor, block]);

const updateCell = useCallback((rowId: string, colId: string, value: CellValue) => {
  const newRows = rows.map(r =>
    r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r
  );
  updateRows(newRows);
}, [rows, updateRows]);
```

---

## `DatabaseHeader.tsx`

Each header cell is a `useSortable` drag target (like the reference repo's
`table-header.tsx`):

```tsx
const DatabaseHeader = ({ header, column, onRename, onDelete, onTypeChange }) => {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useSortable({
    id: header.column.id,
  });

  return (
    <th ref={setNodeRef} style={...} onClick={header.column.getToggleSortingHandler()}>
      <div className="flex items-center justify-between">
        <span>{column.name}</span>
        {/* sort indicator */}
        {{ asc: "↑", desc: "↓" }[header.column.getIsSorted() as string] ?? null}
        {/* drag handle */}
        <button {...attributes} {...listeners}>⋮⋮</button>
        {/* column menu trigger */}
        <ColumnMenu column={column} onRename={onRename} onDelete={onDelete} onTypeChange={onTypeChange} />
      </div>
      {/* resize handle */}
      <div
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        className="resizer"
      />
    </th>
  );
};
```

---

## `DatabaseCell.tsx`

Each cell renders a type-appropriate editor (see [04-column-types.md](./04-column-types.md)):

```tsx
const DatabaseCell = ({ cell, row, column, onCellChange }) => {
  const { isDragging, setNodeRef, transform } = useSortable({
    id: cell.column.id,
  });

  const value = cell.getValue();
  const dbColumn: DatabaseColumn = cell.column.columnDef.meta?.dbColumn;

  return (
    <td ref={setNodeRef} style={...}>
      <CellEditor
        type={dbColumn.type}
        value={value}
        config={dbColumn.config}
        onChange={(newVal) => onCellChange(row.id, dbColumn.id, newVal)}
      />
    </td>
  );
};
```

---

## `AddRowButton`

A simple footer row:

```tsx
<tfoot>
  <tr>
    <td colSpan={columns.length + 1}>
      <button onClick={addRow} className="text-gray-400 hover:text-gray-600">
        + New row
      </button>
    </td>
  </tr>
</tfoot>
```

---

## Styling approach

Use Tailwind utility classes matching the app's existing style, supplemented by
a small set of CSS classes for table-specific concerns (resizer, drag handle)
adapted from the reference repo's `globals.css`:

```css
/* src/app/globals.css — add at bottom */
.db-table          { border-spacing: 0; border: 1px solid #e5e7eb; border-radius: 0.5rem; overflow: hidden; }
.db-th, .db-td     { border-bottom: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb; padding: 6px 10px; position: relative; }
.db-th:last-child,
.db-td:last-child  { border-right: 0; }
.db-th              { color: #6b7280; font-weight: 500; font-size: 0.8125rem; background: #f9fafb; }
.db-resizer         { position: absolute; right: 0; top: 0; width: 4px; height: 100%; cursor: col-resize; background: transparent; }
.db-resizer:hover   { background: #93c5fd; }
```
