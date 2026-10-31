# @alexpricedev/billet-cms

The block plugin a [Billet](https://github.com/alexpricedev/Billet) site installs, and the contract the site and the
`billet-cms` service share. A site declares its blocks, slots and page types
with the field vocabulary and publishes them on deploy; the CMS service reads
those rows and never imports site code.

```ts
import { block, group, list, slot, text } from "@alexpricedev/billet-cms/fields";

export const hero = block(
  "hero",
  { label: "Hero" },
  {
    heading: text({ max: 80 }),
    // A repeated pair: `list()` repeats one field, `group()` holds several.
    steps: list(group({ title: text({ max: 60 }), body: text({ max: 200 })})),
  },
);

export const homeHero = slot("home.hero", hero);
```

`block()` takes the block's name, an options object, its fields, and an optional
render function. The one option is `label`, the human name the CMS shows — a
block's legend and its Add block menu read "Full-width image", never
`fullImage` — and it is required: a missing or blank label throws where the block
is declared. The label is published to the CMS with the rest of the definition,
so changing it takes a deploy.

The render function is optional, for a site that keeps its markup next to the
declaration. Nothing in this package calls it — the CMS builds its form from the
published metadata — so a site that renders in templates should leave it out.

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

### Where skips are logged

Skips go to the console by default, throttled so each distinct message is
reported at most once a minute. The throttle is the difference between a useful
log and an unreadable one: a skip is per subject per read, so a site whose CMS
is not set up yet — the state it is in between deploying the plugin and
deploying the CMS — reports one line per slot on *every* request. What that
buries is the line that matters later, a single slot whose stored content
stopped validating.

Pass `onSkip` to send them somewhere else. Build a reader to do it, and wrap
your own sink in `throttleSkips` to keep the behaviour:

```ts
import {
  createContentReader,
  throttleSkips,
} from "@alexpricedev/billet-cms/server";

const reader = createContentReader({
  sql,
  onSkip: throttleSkips((message) => log.warn("cms", message)),
});

const content = await reader.getSlot("home.hero", { block: hero });
```

A reader's `getSlot` takes and returns exactly what the top-level one does,
including inferring the content type from `{ block }`, so reaching for your own
logger costs nothing else.

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

`getPreviewAccess` reads `?cms_preview=` and returns
`{ subjectType, subjectId, draftSavedAt }` for a live token, or `null` for a
missing, unknown, expired or unreadable one — so a caller never branches on an
error. Pass that access to `getSlot` (or `getPage`) as `{ preview }`: when the
token's subject is that slot or page the newest draft is read, uncached; `null`
is the published read, so it can be forwarded without a check. `applyPreview`
sets `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and injects the
Preview banner into an HTML response — the headers alone for anything else, and
the response untouched when the access is `null`.

Forward the same `{ preview }` to `resolveLink`. A `link()` to a page is stored
as an id, and outside a preview only *published* pages resolve — a link to a
draft returns `null`, so the site renders no button and the editor sees a
preview with its buttons missing. With valid preview access a link to an
unpublished page resolves to that page's URL, including a link to the page being
previewed. Any valid access (a page's or a slot's token) resolves every draft,
so a cross-link between two drafts has an href; following it still needs the
target's own token or it 404s, which is more honest than a missing button. A
published target keeps resolving from the published route cache; a draft costs
one direct read, memoised per access so a page linking it repeatedly reads it
once, and no draft URL ever enters that cache.

The banner names when the draft was saved (`draftSavedAt`, read in the same
query as the token). That line is doing a job: an editor who types, hits Preview
without saving and sees their old words has nothing on the page to tell them
why, and a time they can compare against the save they remember making turns a
mystery into an explanation. A site that forwards or fakes an access without it
gets the undated banner.

A slot has no URL of its own, so it declares the site path whose Preview opens
it, and the CMS opens that page:

```ts
export const homeHero = slot("home.hero", hero, { previewPath: "/" });
```

The catch-all (`createCmsPageRoute`) does this for a CMS-served page: it hands
its `render` function `{ preview, req }`, so a page that also mounts a slot can
forward the access and show that slot's draft inside it. Forward it to
`resolveLink` as well, or the previewed page's draft links stay `null`.

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

> **Caching:** set `Cache-Control: public, max-age=31536000, immutable` on
> `media/*` as a bucket or CDN rule. Object keys carry a UUID per upload and are
> never rewritten, so a browser (or CDN) can keep an image indefinitely without
> a revalidation or a stale file. The CMS can't set the header itself — Bun's S3
> client has no per-object cache-control option — so it belongs in the bucket's
> configuration.
>
> **Deleting an image doesn't purge a CDN.** The CMS removes the object from the
> bucket, but a CDN edge that already holds it can keep serving its copy until
> that edge's own TTL expires. If a deletion has to take effect immediately
> (a mistaken upload of something private), purge the `media/<id>/…` paths in the
> CDN by hand as well as deleting the row.

## Installing in a site

The full walkthrough — the site's files, the code for each step, the
environment and the deploy order — is
[`runbooks/INSTALLING-IN-A-SITE.md`](https://github.com/alexpricedev/billet-cms/blob/main/runbooks/INSTALLING-IN-A-SITE.md).
This section is the reference for the pieces it mounts.

```bash
bun add @alexpricedev/billet-cms zod
```

`zod@^4` is a peer. Bun installs it on its own, but naming it keeps the version
the site runs in `package.json` — and a package manager that does not
auto-install peers leaves it out, and the server will not boot without it.

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
     { label: "Hero" },
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
   Billet's SEO runbook. `pageSeo` is async and takes the media reader as
   `media`, because a page's social image is an upload id, not a URL:

   ```ts
   import { getCmsMediaReader, pageSeo } from "@alexpricedev/billet-cms/server";

   const seo = await pageSeo(page, {
     siteUrl: siteUrl(),
     fallbackDescription: SITE_DESCRIPTION,
     media: getCmsMediaReader(sql),
   });
   ```

   It puts the smallest rendition at least 1200px wide (or the largest there
   is) into `og:image` and `twitter:image`. Without `media`, or for a deleted
   upload, the image tags are left out and everything else is unchanged.

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

   A signed-in user who isn't an editor gets a small 403 page that says who to
   ask and links back to the site. Pass `renderRefusal: ({ req, homeUrl }) =>
   Response` to render your own (the status is forced to 403).

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
CMS_EXPORT_TOKEN=… bunx billet-cms-pull --from https://cms.example.com
# or, with the script below: CMS_EXPORT_TOKEN=… bun run cms:pull --from https://cms.example.com
```

Prefer the `CMS_EXPORT_TOKEN` environment variable over `--token` so the token
doesn't land in your shell history or a process listing.

Add the convenience script to the site's `package.json`:

```json
"cms:pull": "billet-cms-pull"
```

The token comes from `CMS_EXPORT_TOKEN` (preferred) or `--token`; an admin
creates it in the CMS under **Export**. The command fetches `GET /export` and **replaces** local
`cms_` content (pages, slots, published revisions, redirects, media rows) with
what came back. It is one-way and the export never contains drafts, definitions,
users, sessions or tokens — but because it replaces local content wholesale, it
**discards local drafts** too: anything unpublished in the local CMS is gone
after a pull. Images keep pointing at the production bucket, and it **refuses to
run under `NODE_ENV=production`**.


