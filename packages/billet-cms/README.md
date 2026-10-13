# @alexpricedev/billet-cms

The block plugin a Billet site installs, and the contract the site and the
`billet-cms` service share. A site declares its blocks, slots and page types
with the field vocabulary and publishes them on deploy; the CMS service reads
those rows and never imports site code.

```ts
import { block, slot, text } from "@alexpricedev/billet-cms/fields";

export const hero = block("hero", { heading: text({ max: 80 }) }, (content) => (
  <h1>{content.heading}</h1>
));

export const homeHero = slot("home.hero", hero);
```

## Reading published content on the site

`@alexpricedev/billet-cms/server` holds the server-side read helpers and the
rich text renderer. They take the site's own database pool (the same one its
Billet tables use) and never reach a browser bundle.

```ts
import { getSlot } from "@alexpricedev/billet-cms/server";
import { hero } from "./blocks/hero";

const content = await getSlot(sql, "home.hero", { block: hero });
```

`getSlot(sql, name)` validates the stored revision against the JSON Schema the
site published and returns it, or `null` when the slot is unpublished, its block
was removed, or the row no longer validates. Nothing throws on a page: a bad row
is logged and skipped so the rest of the page still renders. Reads are cached in
memory and re-checked against `cms_meta.content_version` at most once a second,
so a publish shows within seconds; if the version check itself fails, the last
good content keeps being served and the failure is reported.

Pass `{ block }` to check the content against the block's own Zod schema as
well. The content type is inferred from the definition, so a render function is
handed exactly what its fields declare, and content the schema rejects is
logged and returned as `null`.
