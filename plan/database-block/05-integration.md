# Database Block — Integration with Existing Codebase

## 1. Editor Schema (`src/lib/editorSchema.ts`)

**Current state** — only extends inline content:

```ts
import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core";
import { PageLink } from "./pageLink";

export const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageLink: PageLink,
  },
});
```

**After** — also extends block specs:

```ts
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { PageLink } from "./pageLink";
import { createDatabaseBlock } from "./databaseBlock";

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    database: createDatabaseBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageLink: PageLink,
  },
});
```

> ⚠️ Adding `blockSpecs` with the spread of `defaultBlockSpecs` ensures we keep
> paragraph, heading, bulletList, etc. Without the spread the editor would ONLY
> have our custom block.

---

## 2. Slash Menu (`src/components/DocumentEditor.tsx`)

The existing `DocumentEditor` already overrides the slash menu with custom items
(PageLink, Mention). We add a `/database` item:

```tsx
// Inside the custom slash menu items builder:

const insertDatabaseItem = {
  title: "Database",
  subtext: "Insert an inline database table",
  onItemClick: () => {
    const defaultCol = {
      id: crypto.randomUUID(),
      name: "Name",
      type: "text",
      width: 200,
    };
    const defaultRow = {
      id: crypto.randomUUID(),
      cells: { [defaultCol.id]: "" },
    };
    editor.insertBlocks(
      [{
        type: "database",
        props: {
          columns: JSON.stringify([defaultCol]),
          rows: JSON.stringify([defaultRow]),
        },
      }],
      editor.getTextCursorPosition().block,
      "after"
    );
  },
  aliases: ["database", "table", "db", "spreadsheet"],
  group: "Advanced",
  icon: <TableIcon size={18} />,   // from lucide-react
};
```

Then merge into the suggestions:

```tsx
const customSlashMenuItems = [
  ...getDefaultReactSlashMenuItems(editor),
  insertDatabaseItem,
  // ...existing PageLink item, etc.
];
```

---

## 3. Save / Persistence

**No changes needed.** The existing `saveDocument` already serialises the full
BlockNote document as JSON via `editor.document` and writes it to the
`documents.content` column in Supabase. Since our database block's data is
stored in the block's props, it's automatically included.

### Potential concern: document size

A large database (50 cols × 500 rows) adds ~100–200 KB to the document. The
`documents.content` column is `text` (unlimited in Postgres). The existing
debounced save (500ms) handles this fine.

---

## 4. Dependencies (`package.json`)

Add one new dependency:

```bash
npm install @tanstack/react-table
```

`@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` are already
installed and used for the existing drag-and-drop filing feature.

---

## 5. Styles

### Option A: Tailwind inline (preferred)

Use Tailwind classes directly in the components. The app already uses Tailwind v4.

### Option B: Small CSS file

Add database-table-specific styles (resizer, drag-handle) to
`src/app/globals.css`. See the CSS snippet in
[03-table-component.md](./03-table-component.md#styling-approach).

### Recommendation

Use Tailwind for layout/spacing/colours and add only the resizer + drag-handle
styles as CSS (they need `::before` / hover states that are cleaner in CSS).

---

## 6. Existing Feature Interactions

### Annotations

The annotation system targets blocks by `block.id`. A database block will have a
single `block.id` — annotations can be attached to it like any other block. The
yellow highlight / floating chat will appear on the entire table block, which is
the correct behaviour.

### Full-text search

The existing FTS is based on the `documents.content` text column. Since database
rows are stored as JSON strings inside the content, Postgres FTS will index the
raw JSON text. This means:
- Searching "Design spec" will match if that text appears in a cell value.
- The ranking might be lower since it's buried in JSON. Acceptable for v1.

### Backlinks / PageLinks

If a database cell contains text that looks like a document title, it won't
automatically create a backlink (PageLinks are inline content, not raw text).
This is expected behaviour — databases are structured data, not prose.

### Export / Import

The `NotionImport` component imports markdown. Database blocks won't be created
from imported markdown (no markdown equivalent). This is fine.

### Copy/Paste

BlockNote handles serialisation of custom blocks to HTML via `toExternalHTML`.
We'll implement a basic `toExternalHTML` that renders the table as an HTML
`<table>` element for clipboard export:

```tsx
toExternalHTML: (props) => {
  const columns = parseColumns(props.block.props.columns);
  const rows = parseRows(props.block.props.rows);
  return (
    <table>
      <thead><tr>{columns.map(c => <th key={c.id}>{c.name}</th>)}</tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id}>{columns.map(c => <td key={c.id}>{String(r.cells[c.id] ?? "")}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
},
```

---

## 7. Type Safety

The custom schema means `editor.document` will include blocks of type
`"database"`. Existing code that iterates over blocks (e.g., for backlink
parsing) should handle unknown block types gracefully — which it already does
since it only looks for `pageLink` inline content inside `"paragraph"` and
`"heading"` blocks.
