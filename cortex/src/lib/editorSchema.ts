import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core";
import { PageLink } from "./pageLink";

// Custom BlockNote schema that extends the default with our PageLink inline content.
export const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageLink: PageLink,
  },
});
