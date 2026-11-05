import { humanise } from "./humanise";

/**
 * A block type in an editor's words: its label, else its name humanised.
 *
 * Migration `021` left existing `cms_block_types` rows with an empty label until
 * the site republishes with a version that carries one, so an empty label is a
 * real state and must read as `fullImage` → "Full image", never as a blank.
 */
export const blockLabel = (blockType: { label: string; name: string }) =>
  blockType.label || humanise(blockType.name);
