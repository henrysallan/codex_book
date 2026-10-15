// Shape of Cortex's custom BlockNote content — type names, props and content
// model — kept apart from how each one renders.
//
// The web editor (pageLink.tsx, databaseBlock.tsx) and the iOS editor
// (mobile/) each pair these configs with their own render. Both must use the
// same configs: an editor whose schema lacks `database` or `pageLink` drops
// those nodes when it loads a note, and its next save deletes them everywhere.
//
// No runtime imports — mobile/ imports this file across the package boundary.

export const pageLinkConfig = {
  type: "pageLink",
  propSchema: {
    docId: { default: "" },
    docTitle: { default: "Untitled" },
  },
  content: "none",
} as const;

export const databaseBlockConfig = {
  type: "database",
  propSchema: {
    // JSON strings (double-encoded) — see databaseTypes.ts.
    columns: { default: "[]" },
    rows: { default: "[]" },
  },
  content: "none",
} as const;
