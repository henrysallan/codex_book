"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import { useAppStore } from "@/lib/store";

// Custom inline content type for page links.
// Renders as a clickable pill that navigates to the linked document.
export const PageLink = createReactInlineContentSpec(
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
      const openDocument = useAppStore((s) => s.openDocument);

      return (
        <span
          style={{
            backgroundColor: "rgba(35, 131, 226, 0.14)",
            color: "rgb(35, 131, 226)",
            padding: "1px 6px",
            borderRadius: "3px",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "inherit",
            lineHeight: "inherit",
            whiteSpace: "nowrap",
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const docId = props.inlineContent.props.docId;
            if (docId) {
              openDocument(docId);
            }
          }}
          onMouseDown={(e) => {
            // Prevent ProseMirror from capturing this as a selection event
            e.stopPropagation();
          }}
        >
          ↗ {props.inlineContent.props.docTitle}
        </span>
      );
    },
  }
);
