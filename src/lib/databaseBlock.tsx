"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { DatabaseTable } from "@/components/DatabaseTable";
import { parseColumns, parseRows } from "./databaseTypes";

export const DatabaseBlock = createReactBlockSpec(
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
            contentEditable={false}
            style={{ width: "100%" }}
          >
            <DatabaseTable
              block={props.block}
              editor={props.editor}
            />
          </div>
        );
      },
      toExternalHTML: (props) => {
        const columns = parseColumns(props.block.props.columns);
        const rows = parseRows(props.block.props.rows);
        return (
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.id}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.id}>{String(r.cells[c.id] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      },
    }
  );
