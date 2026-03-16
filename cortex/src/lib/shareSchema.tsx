"use client";

import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactInlineContentSpec, createReactBlockSpec } from "@blocknote/react";
import { withMultiColumn } from "@blocknote/xl-multi-column";
import { parseColumns, parseRows } from "./databaseTypes";

// ─── Read-only PageLink for share pages ───
// Receives pageLinkMap + click handler via React context (set by SharePageClient).

import { createContext, useContext } from "react";

interface ShareContext {
  pageLinkMap: Record<string, string | null>;
  onPrivateLink: () => void;
}

export const ShareCtx = createContext<ShareContext>({
  pageLinkMap: {},
  onPrivateLink: () => {},
});

const SharePageLink = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: {
      docId: { default: "" },
      docTitle: { default: "Untitled" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const { pageLinkMap, onPrivateLink } = useContext(ShareCtx);
      const docId = props.inlineContent.props.docId;
      const slug = pageLinkMap[docId];

      return (
        <span
          style={{
            backgroundColor: "rgba(35, 131, 226, 0.14)",
            color: "rgb(35, 131, 226)",
            padding: "1px 6px",
            borderRadius: "3px",
            cursor: slug ? "pointer" : "default",
            fontWeight: 500,
            fontSize: "inherit",
            lineHeight: "inherit",
            whiteSpace: "nowrap",
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (slug) {
              window.open(`/share/${slug}`, "_blank");
            } else {
              onPrivateLink();
            }
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ↗ {props.inlineContent.props.docTitle}
        </span>
      );
    },
  }
);

// ─── Read-only DatabaseBlock for share pages ───
// Renders a static HTML table (no editing, no DnD, no column menus).

const ShareDatabaseBlock = createReactBlockSpec(
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
      const columns = parseColumns(props.block.props.columns);
      const rows = parseRows(props.block.props.rows);

      if (columns.length === 0) return <div />;

      return (
        <div contentEditable={false} style={{ width: "100%", overflowX: "auto" }}>
          <table className="db-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className="db-th"
                    style={{ width: c.width, cursor: "default" }}
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => {
                    const val = r.cells[c.id];
                    let display: React.ReactNode = String(val ?? "");

                    if (c.type === "checkbox") {
                      display = val ? "☑" : "☐";
                    } else if (c.type === "select" && val) {
                      display = (
                        <span
                          style={{
                            display: "inline-block",
                            padding: "1px 8px",
                            borderRadius: "3px",
                            backgroundColor: "#f0f0f0",
                            fontSize: "0.8125rem",
                          }}
                        >
                          {String(val)}
                        </span>
                      );
                    }

                    return (
                      <td key={c.id} className="db-td" style={{ cursor: "default" }}>
                        {display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    },
  }
);

// ─── Schema for the share page ───

export const shareSchema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      database: ShareDatabaseBlock(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      pageLink: SharePageLink,
    },
  })
);
