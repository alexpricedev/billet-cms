/**
 * The definitions the e2e site declares and publishes on deploy.
 *
 * This is the "site code" half of the contract: a block, a slot and a page type,
 * written with the plugin's field vocabulary. Deploying is
 * `publish(sql, siteDefinitions)` — the same call `bunx billet-cms-publish`
 * makes (see `e2e/e2e.test.ts`) — after which the CMS builds its form from the
 * published metadata and never imports this file.
 */
import {
  block,
  image,
  pageType,
  slot,
  text,
} from "../packages/billet-cms/src/fields/index.ts";

export const hero = block(
  "hero",
  {
    heading: text({ max: 120, label: "Heading" }),
    // `minWidth` guidance is enforced by the CMS when the draft is saved, so the
    // seeded media row has to be wide enough.
    photo: image({ label: "Photo", minWidth: 400 }),
  },
  (content) => ({ heading: content.heading, photo: content.photo }),
);

export const homeHero = slot("home.hero", hero, {
  label: "Home hero",
  previewPath: "/",
});

export const landing = pageType("landing", {
  label: "Landing",
  allowedBlocks: [hero],
  requiredBlocks: [],
  limits: { hero: { max: 1 } },
});

export const siteDefinitions = {
  blocks: [hero],
  slots: [homeHero],
  pageTypes: [landing],
};
