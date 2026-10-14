# @alexpricedev/billet-cms

The block plugin a [Billet](https://github.com/alexpricedev/Billet) site installs, and the contract the site and the
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

## Preview

Preview is a token row, not an API. The CMS mints a short-lived token for one
subject — a page or a slot — and opens the real page with `?cms_preview=…`; the
plugin checks the row and renders that subject's newest draft. Three calls make
up the site half, in order:

```ts
import {
  applyPreview,
  getPreviewAccess,
  getSlot,
} from "@alexpricedev/billet-cms/server";

const preview = await getPreviewAccess(sql, req); // null without a valid token
const content = await getSlot(sql, "home.hero", { block: hero, preview });
const response = await applyPreview(render(content), preview);
```

`getPreviewAccess` reads `?cms_preview=` and returns `{ subjectType, subjectId }`
for a live token, or `null` for a missing, unknown, expired or unreadable one —
so a caller never branches on an error. Pass that access to `getSlot` (or
`getPage`) as `{ preview }`: when the token's subject is that slot or page the
newest draft is read, uncached; `null` is the published read, so it can be
forwarded without a check. `applyPreview` sets `Cache-Control: no-store` and
`X-Robots-Tag: noindex`, and injects the Preview banner into an HTML response —
the headers alone for anything else, and the response untouched when the access
is `null`.

A slot has no URL of its own, so it declares the site path whose Preview opens
it, and the CMS opens that page:

```ts
export const homeHero = slot("home.hero", hero, { previewPath: "/" });
```

The catch-all (`createCmsPageRoute`) does this for a CMS-served page: it hands
its `render` function `{ preview, req }`, so a page that also mounts a slot can
forward the access and show that slot's draft inside it.

## Images

An `image()` field stores only a `mediaId`. Read the upload row and render it:

```ts
import { getMedia, renderCmsImage } from "@alexpricedev/billet-cms/server";

const media = await getMedia(sql, content.photo.mediaId);
const html = media
  ? renderCmsImage(media, { alt: content.photo.alt })
  : "";
```

`renderCmsImage` (the plugin's `<CmsImage>`) emits a `<picture>` with a WebP
`<source>`, the original format as the fallback, a full `srcset` at the widths
the CMS generated, `width`/`height` so the browser reserves the right space, and
`object-fit: cover` with `object-position` from the editor's focal point. Pass
`{ alt }` with a use's own override (the image field's `alt`), or omit it to use
the media item's own; pass `{ sizes }` to match your layout (it defaults to
`100vw`). A row that is missing or has no renditions reads as `null`, and
`renderCmsImage` returns `""`, so a page never shows a broken image.

Reads are cached against `cms_meta.content_version` exactly like `getSlot`, so a
focal-point or alt change shows within about a second.

> **CSP:** images are served from your bucket, not this app, so the site's
> `img-src` must allow the bucket's host (the origin in `MEDIA_PUBLIC_BASE_URL`).
> Without it the browser blocks every CMS image — the markup is correct and the
> network tab is the only place it shows.

## Installing in a site

```bash
bun add @alexpricedev/billet-cms
```

1. **Declare the site's blocks, slots and page types** in a `cms.config.ts`.
   Export the arrays by name (or from a default export):

   ```ts
   import {
     block,
     image,
     pageType,
     slot,
     text,
   } from "@alexpricedev/billet-cms/fields";

   export const hero = block(
     "hero",
     { heading: text({ max: 80, label: "Heading" }), photo: image() },
     (content) => `<h1>${content.heading}</h1>`,
   );
   export const homeHero = slot("home.hero", hero, { previewPath: "/" });
   export const landing = pageType("landing", {
     allowedBlocks: [hero],
     limits: { hero: { max: 1 } },
   });

   export const blocks = [hero];
   export const slots = [homeHero];
   export const pageTypes = [landing];
   ```

2. **Publish on deploy**, after the CMS is up (see the deploy order below):

   ```bash
   bunx billet-cms-publish            # reads ./cms.config.ts, uses DATABASE_URL
   ```

   It needs the same `DATABASE_URL` as the site's own Billet app, because the
   CMS shares that database. A missing or mismatched contract version stops with
   a message telling you which side to upgrade.

3. **Read content in templates** with `getSlot` (above), and mount the catch-all
   in the site's fallback — after every one of the site's own routes, just before
   its 404 — so CMS pages are served and 301s are honoured:

   ```ts
   import { createCmsPageRoute } from "@alexpricedev/billet-cms/server";

   const cmsPage = createCmsPageRoute({
     sql,
     render: (page, { preview, req }) =>
       new Response(renderCmsPage(page, preview)),
   });

   // In your fallback, before render404():
   const cmsPageResponse = await cmsPage(req);
   if (cmsPageResponse) return cmsPageResponse;
   ```

   Forward `preview` from the render context to any `getSlot` the page mounts, so
   a previewed slot shows its draft inside a CMS-served page.

4. **Merge the CMS pages into the site's sitemap** with `listSitemapEntries(sql)`,
   and set canonical URLs and social tags from `pageSeo`/`renderSeoTags`. Follow
   Billet's SEO runbook.

5. **Mount CMS sign-in** at the path the contract fixes:

   ```ts
   import { handleCmsSignIn } from "@alexpricedev/billet-cms/sign-in";

   "/cms/sign-in": (req) =>
     handleCmsSignIn(req, {
       sql,
       getUserId: (request) => currentUserId(request),
       cmsUrl: process.env.CMS_URL,
     }),
   ```

   And render an **Edit content** link for a signed-in admin with
   `createEditContentLink(sql, { userId })`; it returns `null` when `CMS_URL` is
   unset, so the link simply hides.

### Environment

| Variable | Where | What |
|---|---|---|
| `CMS_URL` | site | The CMS origin, e.g. `https://cms.example.com`. The Edit content link and sign-in are hidden/disabled without it. |
| `DATABASE_URL` | site | The shared Postgres. The same value the CMS is given. |
| `CMS_EXPORT_TOKEN` | site (local/preview only) | The export token `cms:pull` presents to `GET /export`. An admin creates it in the CMS under **Export**. Never set it in production. |

### Deploy order and the CSP

- **Deploy the CMS first, then the site.** The CMS creates the `cms_` tables at
  boot; the site's publish step checks `cms_meta.contract_version` and stops
  until the CMS has set it up.
- **The site's CSP `img-src` must allow the media bucket's host** (the origin in
  `MEDIA_PUBLIC_BASE_URL`, which the CMS sets). Without it the browser blocks
  every `<CmsImage>`.
- On Railway, the CMS is its own service from this repo, connected to the site's
  Postgres. See the root `README.md`.

## Export and pull

Pull production content into a local or preview environment without database
credentials:

```bash
bunx billet-cms-pull --from https://cms.example.com
# or, with the script below: bun run cms:pull --from https://cms.example.com
```

Add the convenience script to the site's `package.json`:

```json
"cms:pull": "billet-cms-pull"
```

The token comes from `--token` or `CMS_EXPORT_TOKEN`; an admin creates it in the
CMS under **Export**. The command fetches `GET /export` and **replaces** local
`cms_` content (pages, slots, published revisions, redirects, media rows) with
what came back. It is one-way and the export never contains drafts, definitions,
users, sessions or tokens — but because it replaces local content wholesale, it
**discards local drafts** too: anything unpublished in the local CMS is gone
after a pull. Images keep pointing at the production bucket, and it **refuses to
run under `NODE_ENV=production`**.


