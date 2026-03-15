# Database Block — BlockNote Block Spec

## API reference

BlockNote's `createReactBlockSpec` takes:

1. **Block config** — `{ type, propSchema, content }` (like `createReactInlineContentSpec`)
2. **Block implementation** — `{ render, toExternalHTML?, parse?, meta? }`

The render function receives `{ block, editor }`. Since `content: "none"`, there
is no `contentRef`.

---

## File: `src/lib/databaseBlock.tsx`

```tsx
"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { DatabaseTable } from "@/components/DatabaseTable";

/**
 * Custom BlockNote block that renders an inline database (TanStack Table).
 *
 * Props are JSON-stringified arrays:
 *   columns — DatabaseColumn[]
 *   rows    — DatabaseRow[]
 *
 * We set content: "none" because the block has no editable inline content —
 * all editing happens via the DatabaseTable React component.
 */
export const createDatabaseBlock = createReactBlockSpec(
  {
    type: "database" as const,
    propSchema: {
      columns: { default: "[]" },
      rows: { default: "[]" },
    },
    content: "none",
  },
  {
    render: (props) => {
      return (
        <div
          contentEditable={false}    // ← critical: prevents ProseMirror cursor
          style={{ width: "100%" }}
        >
          <DatabaseTable
            block={props.block}
            editor={props.editor}
          />
        </div>
      );
    },
    meta: {
      /**
       * selectable: true allows the block to be selected with click
       * (shows the blue selection ring) but not edited as text.
       */
      selectable: true,
    },
  }
);
```

### Key decisions

| Decision | Rationale |
|---|---|
| `content: "none"` | The table manages its own editing; no ProseMirror inline content needed. |
| `contentEditable={false}` | Prevents ProseMirror from capturing keystrokes inside the table. All cell editing is handled by React state + `<input>` / `<select>` elements. |
| Props as JSON strings | BlockNote serialises props as TipTap node attributes (strings). Complex objects must be stringified. |
| `meta.selectable: true` | Lets the user click the block to select it (for deletion, drag, etc.) without entering text editing mode. |

---

## Registering in the schema

In `src/lib/editorSchema.ts`:

```ts
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { PageLink } from "./pageLink";
import { createDatabaseBlock } from "./databaseBlock";

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    database: createDatabaseBlock(),   // ← add to block specs
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageLink: PageLink,
  },
});
```

> **Note**: We now import `defaultBlockSpecs` and spread it so we keep all
> built-in blocks (paragraph, heading, list, image, etc.) alongside our custom
> `database` block.

---

## How data flows

```
User edits cell
       │
       ▼
DatabaseTable calls editor.updateBlock(block, { props: { rows: newRowsJSON } })
       │
       ▼
BlockNote re-renders the block with new props
       │
       ▼
onChange fires in DocumentEditor → saveDocument writes full document JSON to Supabase
```

This means every cell edit is automatically persisted through the existing save
pipeline. No extra DB calls.

---

## Preventing ProseMirror interference

Because the table lives inside a ProseMirror node view:

1. **Keyboard events**: `contentEditable={false}` on the wrapper div stops
   ProseMirror from handling keypresses. Our `<input>` elements inside cells
   capture events normally.

2. **Selection**: Clicking inside the table should NOT create a ProseMirror text
   cursor. The `contentEditable={false}` attribute handles this.

3. **Drag handle**: BlockNote's built-in side menu / drag handle still works on
   the block as a whole — users can drag the entire database block to reorder it
   among other blocks.

4. **Mouse events**: We add `onMouseDown={(e) => e.stopPropagation()}` on
   interactive elements (inputs, selects, resize handles) to prevent ProseMirror
   from stealing focus.
