import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { withMultiColumn } from "@blocknote/xl-multi-column";
import { PageLink } from "./pageLink";
import { DatabaseBlock } from "./databaseBlock";

// Custom BlockNote schema with database block + PageLink inline content + multi-column.
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
  })
);
