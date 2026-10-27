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
  group,
  image,
  link,
  list,
  pageType,
  richText,
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

export const textBlock = block(
  "text",
  { body: richText({ label: "Body" }) },
  (content) => ({ body: content.body }),
);

export const gallery = block(
  "gallery",
  {
    images: list(image({ label: "Image", minWidth: 400 }), {
      label: "Images",
      min: 1,
      max: 6,
    }),
  },
  (content) => ({ images: content.images }),
);

export const quote = block(
  "quote",
  {
    text: text({ max: 400, label: "Quote" }),
    attribution: text({ max: 120, label: "Attribution" }),
    link: link({ label: "Link", required: false }),
  },
  (content) => ({
    text: content.text,
    attribution: content.attribution,
    link: content.link,
  }),
);

export const cta = block(
  "cta",
  {
    heading: text({ max: 120, label: "Heading" }),
    link: link({ label: "Button link" }),
  },
  (content) => ({ heading: content.heading, link: content.link }),
);

export const footerCta = slot("footer.cta", cta, {
  label: "Footer call to action",
  previewPath: "/",
});

/**
 * A repeated pair, which `list()` alone cannot hold. Here so the publish step
 * carries a `group` through real Postgres — the metadata tree, the nested
 * JSON Schema and the schema hash — rather than only through unit tests.
 */
export const steps = block("steps", {
  heading: text({ max: 120, label: "Heading" }),
  items: list(
    group({
      title: text({ max: 60, label: "Title" }),
      body: text({ max: 200, label: "Body" }),
    }),
    { label: "Steps", min: 1, max: 4 },
  ),
});

export const landing = pageType("landing", {
  label: "Landing",
  allowedBlocks: [hero, textBlock, gallery, quote, cta, steps],
  requiredBlocks: [],
  limits: { hero: { max: 1, position: "top" } },
});

export const article = pageType("article", {
  label: "Article",
  allowedBlocks: [textBlock, quote, gallery],
  requiredBlocks: [textBlock],
});

export const siteDefinitions = {
  blocks: [hero, textBlock, gallery, quote, cta, steps],
  slots: [homeHero, footerCta],
  pageTypes: [landing, article],
};
