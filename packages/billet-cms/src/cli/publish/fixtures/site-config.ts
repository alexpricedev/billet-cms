/**
 * A stand-in site config, used by `load.test.ts`.
 *
 * Shaped exactly like a real site's `cms.config.ts`: definitions declared with
 * the field vocabulary, exported by name.
 */
import { block, pageType, slot, text } from "../../../fields";

export const hero = block(
  "hero",
  { label: "Hero" },
  { heading: text({ max: 80 }) },
  () => null,
);

export const blocks = [hero];
export const slots = [slot("home.hero", hero)];
export const pageTypes = [pageType("landing", { allowedBlocks: [hero] })];
