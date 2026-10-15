// Runs inside the editor's web view only — never import from native code.
//
// Same block/inline-content configs as the web editor (shared from
// src/lib/editorSpecConfigs.ts), with phone-sized renders: page links call back
// to native navigation, and database tables render as a read-only list.

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
} from "@blocknote/react";
import { withMultiColumn } from "@blocknote/xl-multi-column";
import { parseColumns, parseRows } from "@cortex/databaseTypes";
import { databaseBlockConfig, pageLinkConfig } from "@cortex/editorSpecConfigs";

// One editor per web view, so a module-level handler is enough.
let openDocHandler: ((docId: string) => void) | null = null;
export function setOpenDocHandler(handler: ((docId: string) => void) | null) {
  openDocHandler = handler;
}

const PageLink = createReactInlineContentSpec(pageLinkConfig, {
  render: ({ inlineContent }) => (
    <span
      className="cx-page-link"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (inlineContent.props.docId)
          openDocHandler?.(inlineContent.props.docId);
      }}
    >
      ↗ {inlineContent.props.docTitle}
    </span>
  ),
});

const DatabaseBlock = createReactBlockSpec(databaseBlockConfig, {
  render: ({ block }) => {
    const columns = parseColumns(block.props.columns);
    const rows = parseRows(block.props.rows);
    const titleCol = columns.find((c) => c.isTitle) ?? columns[0];
    return (
      <div className="cx-db" contentEditable={false}>
        {rows.length === 0 && <div className="cx-db-empty">Empty table</div>}
        {rows.map((row) => {
          const title = String(
            (titleCol && row.cells[titleCol.id]) || "Untitled",
          );
          return (
            <div
              key={row.id}
              className={row.docId ? "cx-db-row cx-db-row-link" : "cx-db-row"}
              onClick={() => row.docId && openDocHandler?.(row.docId)}
            >
              <span>{title}</span>
              {row.docId && <span className="cx-db-chevron">›</span>}
            </div>
          );
        })}
      </div>
    );
  },
});

export const schema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      database: DatabaseBlock(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      pageLink: PageLink,
    },
  }),
);

/**
 * Block and inline types in `blocks` this schema can't represent. Loading such
 * a note would drop those nodes and the next save would delete them for every
 * device, so the editor refuses to open it instead.
 */
export function findUnsupportedTypes(blocks: unknown[]): string[] {
  const blockTypes = new Set(Object.keys(schema.blockSchema));
  const inlineTypes = new Set(Object.keys(schema.inlineContentSchema));
  const missing = new Set<string>();

  const walkInline = (content: unknown): void => {
    if (Array.isArray(content)) {
      for (const c of content) walkInline(c);
      return;
    }
    if (!content || typeof content !== "object") return;
    const node = content as {
      type?: unknown;
      content?: unknown;
      rows?: { cells?: unknown }[];
    };
    if (node.type === "tableContent") {
      for (const row of node.rows ?? []) walkInline(row.cells);
      return;
    }
    if (node.type === "tableCell") {
      walkInline(node.content);
      return;
    }
    if (typeof node.type === "string" && !inlineTypes.has(node.type))
      missing.add(node.type);
    if (node.type === "link") walkInline(node.content);
  };

  const walkBlocks = (list: unknown[]): void => {
    for (const b of list) {
      if (!b || typeof b !== "object") continue;
      const block = b as {
        type?: unknown;
        content?: unknown;
        children?: unknown;
      };
      if (typeof block.type === "string" && !blockTypes.has(block.type))
        missing.add(block.type);
      walkInline(block.content);
      if (Array.isArray(block.children)) walkBlocks(block.children);
    }
  };

  walkBlocks(blocks);
  return [...missing];
}
