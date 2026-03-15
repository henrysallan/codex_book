# Database Block — Data Model

## Design principle

Everything lives inside the block's props as serialised JSON strings. BlockNote
persists block props as node attributes in ProseMirror, so they must be
serialisable (strings, numbers, booleans). We store `columns` and `rows` as
**JSON-stringified** arrays.

When the document is saved, the entire BlockNote document (including the database
block with its data) goes into the existing `documents.content` column as usual —
no extra Supabase table needed.

---

## TypeScript types (`src/lib/databaseTypes.ts`)

```ts
// ─── Column types supported in v1 ───

export type ColumnType = "text" | "number" | "select" | "checkbox" | "date";

// ─── Column definition ───

export interface DatabaseColumn {
  /** Unique stable ID (uuid) */
  id: string;
  /** Display name shown in header */
  name: string;
  /** Data type — determines cell renderer + editor */
  type: ColumnType;
  /** Width in pixels (for column resize) */
  width: number;
  /**
   * Type-specific config. Examples:
   * - select: { options: ["Low", "Medium", "High"] }
   * - number: { format: "currency" }            (v2)
   * - date:   { includeTime: true }              (v2)
   *
   * For v1, only `select.options` is used.
   */
  config?: Record<string, unknown>;
}

// ─── Row ───

export interface DatabaseRow {
  /** Unique stable ID (uuid) */
  id: string;
  /** Map of column-id → cell value */
  cells: Record<string, CellValue>;
}

// ─── Cell value — a discriminated union ───

export type CellValue =
  | string        // text columns
  | number        // number columns
  | boolean       // checkbox columns
  | null;         // empty / unset

// Note: date is stored as ISO-8601 string (typeof === "string").
// Select is stored as a string matching one of the column's options.
```

---

## Block props shape

BlockNote `propSchema` only supports `string`, `number`, and `boolean` defaults.
Complex objects must be JSON-stringified strings:

```ts
propSchema: {
  /** JSON-stringified DatabaseColumn[] */
  columns: { default: "[]" },
  /** JSON-stringified DatabaseRow[] */
  rows: { default: "[]" },
}
```

### Example serialised value

```json
{
  "columns": "[{\"id\":\"col-1\",\"name\":\"Name\",\"type\":\"text\",\"width\":200},{\"id\":\"col-2\",\"name\":\"Status\",\"type\":\"select\",\"width\":140,\"config\":{\"options\":[\"Todo\",\"In Progress\",\"Done\"]}},{\"id\":\"col-3\",\"name\":\"Due\",\"type\":\"date\",\"width\":140}]",
  "rows": "[{\"id\":\"row-1\",\"cells\":{\"col-1\":\"Design spec\",\"col-2\":\"In Progress\",\"col-3\":\"2025-07-15\"}},{\"id\":\"row-2\",\"cells\":{\"col-1\":\"Build UI\",\"col-2\":\"Todo\",\"col-3\":null}}]"
}
```

---

## Parse / serialise helpers

Inside the render component we parse once on mount and re-stringify only on
mutations:

```ts
function parseColumns(raw: string): DatabaseColumn[] {
  try { return JSON.parse(raw); } catch { return []; }
}

function parseRows(raw: string): DatabaseRow[] {
  try { return JSON.parse(raw); } catch { return []; }
}
```

When updating, we call `editor.updateBlock(block, { props: { rows: JSON.stringify(newRows) } })`.

---

## Default state for a freshly-inserted database

When the user types `/database`, we insert a block with sensible defaults — one
text column ("Name") and an empty first row:

```ts
const defaultColumn: DatabaseColumn = {
  id: crypto.randomUUID(),
  name: "Name",
  type: "text",
  width: 200,
};

const defaultRow: DatabaseRow = {
  id: crypto.randomUUID(),
  cells: { [defaultColumn.id]: "" },
};

// Inserted block props:
{
  columns: JSON.stringify([defaultColumn]),
  rows: JSON.stringify([defaultRow]),
}
```

---

## Size considerations

- A document with a 50-column × 500-row database will produce roughly **100–200 KB**
  of JSON — well within Supabase's `text` column limit and comfortable for
  real-time editing.
- For truly large datasets (>1 000 rows), a v2 enhancement would move data to a
  dedicated `database_rows` table and lazy-load pages. Not needed for v1.
