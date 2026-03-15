"use client";

import { useMemo, useState, useCallback, useEffect, useRef, CSSProperties } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  ColumnDef,
  SortingState,
  flexRender,
  Header,
} from "@tanstack/react-table";
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
  MouseSensor,
  TouchSensor,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DatabaseColumn,
  DatabaseRow,
  CellValue,
  ColumnType,
  parseColumns,
  parseRows,
  coerceValue,
} from "@/lib/databaseTypes";
import { CellEditor } from "@/components/database/CellEditor";
import { ColumnMenu } from "@/components/database/ColumnMenu";
import { Plus, GripVertical } from "lucide-react";
import { createDocument as dbCreateDocument, updateDocument as dbUpdateDocument } from "@/lib/db";
import { useAppStore } from "@/lib/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DatabaseTableProps {
  block: any;
  editor: any;
}

export function DatabaseTable({ block, editor }: DatabaseTableProps) {
  const openDocument = useAppStore((s) => s.openDocument);
  const initialize = useAppStore((s) => s.initialize);

  const columns = useMemo(
    () => parseColumns(block.props.columns),
    [block.props.columns]
  );
  const rows = useMemo(
    () => parseRows(block.props.rows),
    [block.props.rows]
  );

  // ─── Mutation helpers ───

  const updateColumns = useCallback(
    (newCols: DatabaseColumn[]) => {
      editor.updateBlock(block, {
        props: { columns: JSON.stringify(newCols) },
      });
    },
    [editor, block]
  );

  const updateRows = useCallback(
    (newRows: DatabaseRow[]) => {
      editor.updateBlock(block, {
        props: { rows: JSON.stringify(newRows) },
      });
    },
    [editor, block]
  );

  const updateBoth = useCallback(
    (newCols: DatabaseColumn[], newRows: DatabaseRow[]) => {
      editor.updateBlock(block, {
        props: {
          columns: JSON.stringify(newCols),
          rows: JSON.stringify(newRows),
        },
      });
    },
    [editor, block]
  );

  const updateCell = useCallback(
    (rowId: string, colId: string, value: CellValue) => {
      const newRows = rows.map((r) =>
        r.id === rowId
          ? { ...r, cells: { ...r.cells, [colId]: value } }
          : r
      );
      updateRows(newRows);

      // If editing the title column, sync title to the linked document
      const titleColId = columns.find((c) => c.isTitle)?.id ?? columns[0]?.id;
      if (colId === titleColId && typeof value === "string") {
        const row = rows.find((r) => r.id === rowId);
        if (row?.docId) {
          dbUpdateDocument(row.docId, { title: value || "Untitled" }).then(() => {
            initialize();
          }).catch((err) => console.error("Failed to sync doc title:", err));
        }
      }
    },
    [rows, columns, updateRows, initialize]
  );

  // ─── Row management ───

  const [isAddingRow, setIsAddingRow] = useState(false);
  const [newRowTitle, setNewRowTitle] = useState("");
  const newRowInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAddingRow) newRowInputRef.current?.focus();
  }, [isAddingRow]);

  const addRow = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const dbDoc = await dbCreateDocument(null, trimmed);
      const titleColId = columns.find((c) => c.isTitle)?.id ?? columns[0]?.id;
      const newRow: DatabaseRow = {
        id: crypto.randomUUID(),
        docId: dbDoc.id,
        cells: Object.fromEntries(
          columns.map((c) => [c.id, c.id === titleColId ? trimmed : null])
        ),
      };
      updateRows([...rows, newRow]);
      await initialize();
    } catch (err) {
      console.error("Failed to create row document:", err);
    }
  }, [columns, rows, updateRows, initialize]);

  const commitNewRow = useCallback(() => {
    const trimmed = newRowTitle.trim();
    if (trimmed) {
      addRow(trimmed);
    }
    setNewRowTitle("");
    setIsAddingRow(false);
  }, [newRowTitle, addRow]);

  const deleteRow = useCallback(
    (rowId: string) => {
      updateRows(rows.filter((r) => r.id !== rowId));
    },
    [rows, updateRows]
  );

  // ─── Column management ───

  const addColumn = useCallback(() => {
    const newCol: DatabaseColumn = {
      id: crypto.randomUUID(),
      name: "Column",
      type: "text",
      width: 150,
    };
    updateColumns([...columns, newCol]);
  }, [columns, updateColumns]);

  const deleteColumn = useCallback(
    (colId: string) => {
      const newCols = columns.filter((c) => c.id !== colId);
      const newRows = rows.map((r) => {
        const newCells = { ...r.cells };
        delete newCells[colId];
        return { ...r, cells: newCells };
      });
      updateBoth(newCols, newRows);
    },
    [columns, rows, updateBoth]
  );

  const renameColumn = useCallback(
    (colId: string, newName: string) => {
      updateColumns(
        columns.map((c) => (c.id === colId ? { ...c, name: newName } : c))
      );
    },
    [columns, updateColumns]
  );

  const changeColumnType = useCallback(
    (colId: string, newType: ColumnType) => {
      const col = columns.find((c) => c.id === colId);
      if (!col || col.type === newType) return;

      const newCols = columns.map((c) =>
        c.id === colId
          ? {
              ...c,
              type: newType,
              config: newType === "select" ? { options: [] } : undefined,
            }
          : c
      );
      const newRows = rows.map((r) => ({
        ...r,
        cells: {
          ...r.cells,
          [colId]: coerceValue(col.type, newType, r.cells[colId], newCols.find((c) => c.id === colId)?.config),
        },
      }));
      updateBoth(newCols, newRows);
    },
    [columns, rows, updateBoth]
  );

  const addSelectOption = useCallback(
    (colId: string, option: string) => {
      updateColumns(
        columns.map((c) => {
          if (c.id !== colId) return c;
          const existing = (c.config?.options as string[]) ?? [];
          if (existing.includes(option)) return c;
          return {
            ...c,
            config: { ...c.config, options: [...existing, option] },
          };
        })
      );
    },
    [columns, updateColumns]
  );

  // ─── TanStack Table setup ───

  const [sorting, setSorting] = useState<SortingState>([]);
  const columnOrder = useMemo(() => columns.map((c) => c.id), [columns]);

  const tanstackColumns: ColumnDef<DatabaseRow>[] = useMemo(
    () =>
      columns.map((col) => ({
        id: col.id,
        accessorFn: (row: DatabaseRow) => row.cells[col.id] ?? null,
        header: col.name,
        size: col.width,
        minSize: 80,
        meta: { dbColumn: col },
      })),
    [columns]
  );

  const table = useReactTable({
    data: rows,
    columns: tanstackColumns,
    state: { sorting, columnOrder },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    getRowId: (row) => row.id,
  });

  // ─── Column DnD ───

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (active && over && active.id !== over.id) {
        const oldIdx = columns.findIndex((c) => c.id === active.id);
        const newIdx = columns.findIndex((c) => c.id === over.id);
        if (oldIdx !== -1 && newIdx !== -1) {
          updateColumns(arrayMove(columns, oldIdx, newIdx));
        }
      }
    },
    [columns, updateColumns]
  );

  // ─── Column resize end ───

  const handleResizeEnd = useCallback(
    (colId: string, newWidth: number) => {
      updateColumns(
        columns.map((c) =>
          c.id === colId ? { ...c, width: Math.max(80, newWidth) } : c
        )
      );
    },
    [columns, updateColumns]
  );

  // ─── Row context menu ───

  const [rowContextMenu, setRowContextMenu] = useState<{
    x: number;
    y: number;
    rowId: string;
  } | null>(null);

  useEffect(() => {
    if (!rowContextMenu) return;
    const handleClick = () => setRowContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [rowContextMenu]);

  return (
    <div className="my-2 overflow-x-auto" onMouseDown={(e) => e.stopPropagation()}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
      >
        <table className="db-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <SortableContext
                  items={columnOrder}
                  strategy={horizontalListSortingStrategy}
                >
                  {headerGroup.headers.map((header) => (
                    <DraggableHeader
                      key={header.id}
                      header={header}
                      column={
                        columns.find((c) => c.id === header.id)!
                      }
                      onRename={(name) => renameColumn(header.id, name)}
                      onTypeChange={(type) =>
                        changeColumnType(header.id, type)
                      }
                      onDelete={() => deleteColumn(header.id)}
                      onAddOption={(opt) =>
                        addSelectOption(header.id, opt)
                      }
                      onResizeEnd={handleResizeEnd}
                    />
                  ))}
                </SortableContext>
                {/* Add column button */}
                <th className="db-th db-add-col">
                  <button
                    onClick={addColumn}
                    className="p-1 rounded transition-colors text-gray-400 hover:text-gray-600"
                  >
                    <Plus size={14} />
                  </button>
                </th>
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="db-td text-center text-gray-400 text-sm py-6"
                >
                  No rows yet. Click + to add one.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="group"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRowContextMenu({ x: e.clientX, y: e.clientY, rowId: row.id });
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const dbCol = (
                      cell.column.columnDef.meta as {
                        dbColumn: DatabaseColumn;
                      }
                    )?.dbColumn;
                    const isTitleCol = dbCol?.isTitle === true;
                    const rowDocId = row.original.docId;
                    return (
                      <SortableContext
                        key={cell.id}
                        items={columnOrder}
                        strategy={horizontalListSortingStrategy}
                      >
                        <DraggableCell
                          cellId={cell.column.id}
                          width={cell.column.getSize()}
                        >
                          <CellEditor
                            type={dbCol?.type ?? "text"}
                            value={cell.getValue() as CellValue}
                            config={dbCol?.config}
                            onChange={(val) =>
                              updateCell(row.id, cell.column.id, val)
                            }
                            docId={isTitleCol ? rowDocId : undefined}
                            onOpenDoc={isTitleCol ? openDocument : undefined}
                          />
                        </DraggableCell>
                      </SortableContext>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={columns.length} className="db-td" style={{ borderBottom: 0 }}>
                {isAddingRow ? (
                  <div className="flex items-center gap-1">
                    <Plus size={14} className="text-gray-400 flex-shrink-0" />
                    <input
                      ref={newRowInputRef}
                      value={newRowTitle}
                      onChange={(e) => setNewRowTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitNewRow();
                        if (e.key === "Escape") { setNewRowTitle(""); setIsAddingRow(false); }
                        e.stopPropagation();
                      }}
                      onBlur={commitNewRow}
                      onMouseDown={(e) => e.stopPropagation()}
                      placeholder="Enter title…"
                      className="flex-1 bg-transparent outline-none text-sm text-gray-700 placeholder:text-gray-300"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setIsAddingRow(true)}
                    className="flex items-center gap-1 text-gray-400 hover:text-gray-600 text-sm transition-colors"
                  >
                    <Plus size={14} />
                    New row
                  </button>
                )}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Row right-click context menu */}
        {rowContextMenu && (
          <div
            className="fixed bg-white rounded-lg border border-gray-200 shadow-lg py-1 min-w-[140px]"
            style={{ top: rowContextMenu.y, left: rowContextMenu.x, zIndex: 9999 }}
          >
            <button
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-red-50 text-sm text-red-600"
              onClick={() => {
                deleteRow(rowContextMenu.rowId);
                setRowContextMenu(null);
              }}
            >
              <span className="text-xs">✕</span>
              Delete row
            </button>
          </div>
        )}
      </DndContext>
    </div>
  );
}

// ─── Draggable Header Cell ───

function DraggableHeader({
  header,
  column,
  onRename,
  onTypeChange,
  onDelete,
  onAddOption,
  onResizeEnd,
}: {
  header: Header<DatabaseRow, unknown>;
  column: DatabaseColumn;
  onRename: (name: string) => void;
  onTypeChange: (type: ColumnType) => void;
  onDelete: () => void;
  onAddOption: (opt: string) => void;
  onResizeEnd: (colId: string, width: number) => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
  } = useSortable({ id: header.id });

  const style: CSSProperties = {
    position: "relative",
    opacity: isDragging ? 0.8 : 1,
    transform: CSS.Translate?.toString(transform) ?? undefined,
    transition: "width transform 0.2s ease-in-out",
    whiteSpace: "nowrap",
    width: header.getSize(),
    zIndex: isDragging ? 1 : 0,
  };

  return (
    <th
      ref={setNodeRef}
      colSpan={header.colSpan}
      style={style}
      className="db-th"
    >
      <div className="flex items-center justify-between gap-1">
        <span
          className="flex items-center gap-1 flex-1 truncate cursor-pointer"
          onClick={header.column.getToggleSortingHandler()}
        >
          {column.name}
          {{ asc: " ↑", desc: " ↓" }[
            header.column.getIsSorted() as string
          ] ?? null}
        </span>

        <span className="flex items-center gap-0.5 flex-shrink-0">
          {/* Column menu */}
          <ColumnMenu
            column={column}
            onRename={onRename}
            onTypeChange={onTypeChange}
            onDelete={onDelete}
            onAddOption={onAddOption}
          />
          {/* Drag handle — hidden, shows on header hover via CSS */}
          <button
            {...attributes}
            {...listeners}
            className="db-drag-handle"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={12} />
          </button>
        </span>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          header.getResizeHandler()(e);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          header.getResizeHandler()(e);
        }}
        onMouseUp={() => {
          onResizeEnd(header.id, header.getSize());
        }}
        className={`db-resizer ${
          header.column.getIsResizing() ? "isResizing" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      />
    </th>
  );
}

// ─── Draggable Cell ───

function DraggableCell({
  cellId,
  width,
  children,
}: {
  cellId: string;
  width: number;
  children: React.ReactNode;
}) {
  const { isDragging, setNodeRef, transform } = useSortable({ id: cellId });

  const style: CSSProperties = {
    width,
    opacity: isDragging ? 0.8 : 1,
    position: "relative",
    transform: CSS.Translate?.toString(transform) ?? undefined,
    transition: "width transform 0.2s ease-in-out",
    zIndex: isDragging ? 1 : 0,
  };

  return (
    <td ref={setNodeRef} style={style} className="db-td">
      {children}
    </td>
  );
}
