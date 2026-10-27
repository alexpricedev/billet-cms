# Installing the CMS in a Billet site

The site half of a CMS install: the plugin a Billet site adds, the definitions it
publishes, and the routes and headers it mounts. The CMS itself is the other
half and lives in this repo — a separate service on `cms.<domain>` (see
[Deploying the CMS](../README.md#deploying-the-cms)). Nothing here puts the CMS
on the site's request path: the site keeps rendering its own pages and reads
published content out of the shared `cms_` tables.

Paths below are Billet core's — `src/server/utils/fallback.ts` and so on. In a
fork, use wherever your equivalents live.

Read [Deploy order](#10-deploy-order) before you start. The CMS has to exist and
have run its migrations before the site's first publish, or the publish stops.

## 1. Install the plugin

```bash
bun add @alexpricedev/billet-cms
```

The package is TypeScript source with no build step, so Bun runs it as-is. One
consequence worth knowing before the first `bun run typecheck`: `skipLibCheck`
only skips `.d.ts`, so the site's own compiler checks this package's `.ts` under
the site's `strict` settings and TypeScript version. A site on an older
TypeScript than the one the package is authored against can see errors inside
`node_modules` that are nothing to do with its own code — the fix is to match
versions, not to work around it locally.

It needs Bun `>=1.4.0`, and it has a `zod@^4` peer. Bun installs that peer
automatically; pin it in `package.json` as well if you want the version the site
runs to be explicit — and do, if anything but Bun ever installs the site, since
a package manager that does not auto-install peers leaves it out and the server
will not boot:

```bash
bun add @alexpricedev/billet-cms zod
```

The package's version and the CMS's contract version are checked against each
other at publish time. Upgrading one side past what the other can read stops the
deploy with a message that names the side to upgrade, rather than writing rows
the other service can't read.

## 2. Declare the site's blocks, slots and page types

A site declares what an editor may put on a page in code, and publishes that
vocabulary into the database. The CMS builds its forms from those rows and never
imports site code.

Put the definitions under `src/` so the same module feeds the publish step, the
templates and the typechecker. For a Billet core site that is
`src/server/cms/definitions.tsx`:

```tsx
import {
  block,
  pageType,
  richText,
  slot,
  text,
  type BlockContent,
} from "@alexpricedev/billet-cms/fields";
import { renderRichText } from "@alexpricedev/billet-cms/server";

export const hero = block(
  "hero",
  {
    heading: text({ max: 80, label: "Heading" }),
    body: richText({ required: false, label: "Body" }),
  },
  (content) => (
    <section class="hero">
      <h1>{content.heading}</h1>
      {content.body ? (
        <div
          dangerouslySetInnerHTML={{ __html: renderRichText(content.body) }}
        />
      ) : null}
    </section>
  ),
);

/** The validated content a block's render function sees, for templates. */
export type HeroContent = BlockContent<typeof hero.fields>;

/** A slot is content the CMS edits in place on a page the site already has. */
export const homeHero = slot("home.hero", hero, {
  previewPath: "/",
  label: "Home hero",
});

/** A page type lets an editor create whole pages at their own URLs. */
export const landing = pageType("landing", {
  allowedBlocks: [hero],
  limits: { hero: { max: 1 } },
});

export const blocks = [hero];
export const slots = [homeHero];
export const pageTypes = [landing];
```

Then the file the publish CLI reads by default, `cms.config.ts` at the site's
root:

```ts
export { blocks, pageTypes, slots } from "./src/server/cms/definitions";
```

Three rules that are easy to get wrong:

- **`render` is never published, and it is optional.** The CMS serialises the
  field vocabulary to JSON Schema; the render function is for the site only, and
  nothing in the package ever calls it. A block can return a Preact element, a
  string, anything — the site owns the markup. A site that renders its blocks in
  templates rather than next to their declarations should leave the argument out
  rather than write a stub.
- **Names are the contract.** A stored page carries the block's `name` in its
  `type` field, so renaming a block is a breaking change: republish, and treat
  the old rows as content that no longer validates (they are skipped, not
  served).
- **A page's blocks are told apart by `type`**, which is why a block may not
  declare a field of that name. The vocabulary rejects it at import time.
- **Repeated pairs are `list(group({...}))`, not two lists.** `list()` repeats a
  single field, so a card with a heading and a body, or a numbered step with a
  title and a description, needs `group()` to hold them together. Two parallel
  lists leave nothing tying `titles[2]` to `bodies[2]`, and the editor sees two
  unrelated controls they can get out of step:

  ```ts
  steps: list(group({ title: text({ max: 60 }), body: text({ max: 200 }) }), {
    min: 1,
    max: 4,
    label: "Steps",
  });
  ```

  A group is a field like any other: it holds an `image()`, it nests in another
  group, and `BlockContent` types its value as a nested object. Fields inside a
  group are strict on save and tolerant on read, the same way a block's own are
  — dropping one from a group in a later deploy leaves the stale key in stored
  content without breaking the read.

`cms.config.ts` sits outside `tsconfig.include` in Billet core (`src/**/*`,
`scripts/**/*.ts`, `.railway/**/*.ts`, `.claude/hooks/**/*`). Bun loads it fine;
add it to `include` if you want `bun run typecheck` to cover it.

## 3. Publish the definitions on deploy

```bash
bunx billet-cms-publish            # reads ./cms.config.ts, uses DATABASE_URL
```

It needs the same `DATABASE_URL` as the site's own Billet app, because the CMS
shares that database. It writes only `cms_` rows, and it is safe to run on every
deploy: unchanged definitions are a no-op.

Add it to the site's scripts so the deploy command is one line:

```json
"cms:publish": "billet-cms-publish"
```

Two failures it reports by name: the CMS hasn't set the database up yet (deploy
order), and the contract versions disagree (upgrade the side it names). Anything
else is printed with its stack, because an operator reading a deploy log needs
the cause.

## 4. Serve CMS pages

An editor-created page is a URL, a title, SEO settings and a list of blocks. The
site renders it; the plugin only answers "is there a page here, or a redirect,
or nothing?". Mount that catch-all after every one of the site's own routes and
just before the 404 — Billet core's `handleFallback` is exactly that place.

`src/server/cms/pages.tsx`:

```tsx
import {
  createCmsPageRoute,
  pageSeo,
  type CmsPage,
  type CmsPageBlock,
} from "@alexpricedev/billet-cms/server";
import { Layout } from "../components/layouts";
import { db } from "../services/database";
import { SITE_DESCRIPTION, siteUrl } from "../services/seo";
import { render } from "../utils/response";
import { hero, type HeroContent } from "./definitions";

/**
 * A stored page's blocks carry a `type` discriminator. Async so a block that
 * reads an image or a link (step 5) can await it; a text-only block just
 * returns its render function's markup.
 */
const renderBlock = async (block: CmsPageBlock): Promise<unknown> => {
  switch (block.type) {
    case "hero":
      return hero.render(block as unknown as HeroContent);
    default:
      // A page published by a newer deploy than this one is serving. Skip the
      // block rather than 500 the page.
      return null;
  }
};

export const cmsPage = createCmsPageRoute({
  sql: db,
  render: async (page: CmsPage, { preview }) => {
    const seo = pageSeo(page, {
      siteUrl: siteUrl(),
      fallbackDescription: SITE_DESCRIPTION,
    });
    const blocks = await Promise.all(page.blocks.map(renderBlock));

    return render(
      <Layout
        title={seo.title}
        name="cms"
        description={seo.description}
        canonicalPath={seo.canonicalPath}
        // A preview is a draft: keep it out of search results.
        noindex={preview !== null}
      >
        <article data-page="cms">
          <h1>{page.title}</h1>
          {blocks}
        </article>
      </Layout>,
    );
  },
});
```

In `src/server/utils/fallback.ts`, after the `/assets/` and `public/` handling,
before `render404()`:

```ts
import { cmsPage } from "../cms/pages";

  // CMS pages and their 301s, after every app route and before the 404.
  const cmsPageResponse = await cmsPage(req);
  if (cmsPageResponse) return cmsPageResponse;

  return render404();
```

What the catch-all does, in order:

- A **301** for an old URL of a page that has been renamed, preserving the query
  string so a preview token survives the move. Cached for an hour.
- A **preview**: a valid `?cms_preview=` token reads that page's newest draft,
  uncached, and wraps the response in a preview banner plus `no-store` and
  `noindex`. An unknown or expired token reads as published.
- The **published page**, from an in-memory cache keyed on
  `cms_meta.content_version` and re-checked at most once a second, so a publish
  shows within about a second and a 404 costs no per-path query.
- **`null`**, so the site's own 404 runs.

Only `GET` and `HEAD` reach it, so form posts to unknown paths still fall
through to the site.

The banner's "Back to the editor" link uses `CMS_URL`; without it the banner
still shows and the link is left out. It also names when the draft was saved, so
an editor who previewed before saving can see why the words are not the ones
they just typed — the site needs nothing for that beyond passing the access
through, which `applyPreview` already does.

## 5. Read a slot on a page you render yourself

Slots are for content that lives inside a page the site already owns, like a
home hero: the CMS edits the content, the site keeps the layout.

```ts
import { getSlot } from "@alexpricedev/billet-cms/server";
import { db } from "../services/database";
import { hero } from "./definitions";

const content = await getSlot(db, "home.hero", { block: hero });
```

- Passing `{ block }` checks the stored revision against the block's own schema
  as well as the JSON Schema published from it, so a block whose code has moved
  past what was stored is a skip. The returned type is inferred from the
  definition.
- `null` means "nothing to render": never filled in, unpublished, removed, or no
  longer validating. It is not an error. Keep the page's hard-coded fallback and
  the site still works before anyone has used the CMS.
- Nothing throws on a page. A missing `cms_` table, an unreachable database or a
  bad row is logged and skipped.

In the template, hand the content to the block's render function and keep a
fallback for the `null` case:

```tsx
{content ? hero.render(content) : <h1>Build with Billet</h1>}
```

### Images and links

An `image()` field stores only a `mediaId`; the upload — its size, renditions
and focal point — is a `cms_media` row. A `link()` stores a page id, which
resolves to whatever URL that page has now. Both are database reads, and a
block's `render` is synchronous, so a block that carries one is rendered by the
site rather than by `render`. Give it a pass-through render:

```tsx
// definitions.tsx
import {
  block,
  image,
  text,
  type BlockContent,
} from "@alexpricedev/billet-cms/fields";

export const feature = block(
  "feature",
  { heading: text({ max: 80, label: "Heading" }), photo: image() },
  // Rendered by the site: the image row is read first. See the template below.
  (content) => content,
);

export type FeatureContent = BlockContent<typeof feature.fields>;
```

```tsx
import { getMedia, renderCmsImage } from "@alexpricedev/billet-cms/server";
import type { FeatureContent } from "./definitions";

const renderFeature = async (content: FeatureContent) => {
  const media = await getMedia(db, content.photo.mediaId);

  return (
    <section class="feature">
      <h2>{content.heading}</h2>
      {media ? (
        <div
          dangerouslySetInnerHTML={{
            __html: renderCmsImage(media, { alt: content.photo.alt }),
          }}
        />
      ) : null}
    </section>
  );
};
```

`renderCmsImage` emits a `<picture>` with a WebP source, the original format as
the fallback, a full `srcset`, `width`/`height`, and the editor's focal point as
`object-position`. It returns an empty string rather than a broken image when
the row is missing or has no renditions.

Add a `feature` case to the dispatcher from step 4, awaiting this function;
`hero` keeps its own synchronous render.

Links work the same way: `resolveLink(link)` on the pages reader returns the
current href, or `null` when the target page is gone. The catch-all's render
function is async (step 4), so these reads can be awaited per block; a slot's
template awaits them before it composes the markup.

**Preview on a page you render yourself.** Read the access once per request and
pass it to each slot:

```ts
import {
  applyPreview,
  getPreviewAccess,
  getSlot,
} from "@alexpricedev/billet-cms/server";

const preview = await getPreviewAccess(db, req);
const content = await getSlot(db, "home.hero", { block: hero, preview });
const response = await applyPreview(render(/* … */), preview);
```

`preview` is `null` for a request without a valid token, so it can be forwarded
without branching. `applyPreview` sets the preview headers (`no-store`,
`noindex`, `no-referrer`), injects the banner into an HTML response, and leaves
the access-`null` case untouched. A CMS page that also mounts a slot can pass
along the `preview` its render function received, which is how a slot preview
shows inside a CMS-served page.

## 6. Mount CMS sign-in

The CMS has no accounts and no sign-in of its own. A signed-out visit is sent to
`<SITE_APP_URL>/cms/sign-in` on the site, which checks the visitor against
`cms_identities`, mints a single-use handoff token and sends them back to the
CMS. The path is fixed by the contract; mount it there.

In `src/server/routes/app.tsx`:

```ts
import type { BunRequest } from "bun";
import { handleCmsSignIn } from "@alexpricedev/billet-cms/sign-in";
import { getSessionContext } from "../middleware/auth";
import { db } from "../services/database";

export const appRoutes = {
  "/cms/sign-in": async (req: BunRequest) =>
    handleCmsSignIn(req, {
      sql: db,
      getUserId: async (request) =>
        (await getSessionContext(request as BunRequest)).user?.id ?? null,
    }),
  // …the rest of the site's routes
};
```

- **`getUserId` is the site's own session lookup.** The plugin knows nothing
  about your cookie; Billet core's `getSessionContext` is the right hook. It is
  called with a `Request`, hence the cast to `BunRequest`, which is what the
  session helper reads cookies from.
- **Nobody signed in** is redirected to the site's own login with a `next` back
  to this route. Billet 5.5.0 and later carry that destination through the
  password path and through a magic link's confirm page, so the editor lands in
  the CMS without a second click. On an older Billet the destination is dropped
  after sign-in: they land on the site and press the CMS link again.
- **A signed-in non-editor** gets a 403 page that says who to ask and links back
  to the site. Pass `renderRefusal: ({ req, homeUrl }) => Response` to render
  your own; the status is forced to 403.
- **Without `CMS_URL`** the route answers 503, because there is nothing to sign
  in to.

Then give editors a way in. Signed in, render an **Edit content** link:

```ts
import { createEditContentLink } from "@alexpricedev/billet-cms/handoff";

const href = await createEditContentLink(db, { userId: ctx.user.id });
```

It returns `null` when `CMS_URL` is unset, or when the user is not in
`cms_identities`, so the link simply hides. Put it on your pages, or in the nav
for admins — a `/cms/sign-in` link works too and is the only entry point on a
site that has not added an Edit button.

### Who counts as an editor

The CMS has no user table. It reads the site's own accounts through
`cms_identities`, a view over `users`. The CMS creates a default one, only when
it is missing:

```sql
SELECT id, email, role FROM users WHERE role = 'admin'
```

That fits Billet core's `users.role` (`'user'` or `'admin'`) and means admins are
editors. A site that wants other people to edit replaces the view in one of its
own migrations — and because core's check constraint only allows those two
roles, a new role needs both a migration and the new view. Once the view exists
the CMS leaves it alone; it only ever creates the default.

## 7. Merge CMS pages into the sitemap

`listSitemapEntries(sql)` returns every published page's URL and
`renderSitemapEntries(entries, { siteUrl })` renders the `<url>` fragments, so
the site's own sitemap builder stays in charge of the document.

Billet core's `src/server/controllers/app/sitemap.ts` becomes async, because the
list is a database read:

```ts
import {
  listSitemapEntries,
  renderSitemapEntries,
} from "@alexpricedev/billet-cms/server";
import { db } from "../../services/database";
import { buildSitemapXml, siteUrl } from "../../services/seo";

export const sitemap = {
  async index(): Promise<Response> {
    const cms = renderSitemapEntries(await listSitemapEntries(db), {
      siteUrl: siteUrl(),
    });
    return new Response(buildSitemapXml(cms), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
```

and `buildSitemapXml` in `src/server/services/seo.ts` takes the fragment:

```ts
export const buildSitemapXml = (extraEntries = ""): string => {
  const urls = SITEMAP_PATHS.map(
    (path) => `  <url>\n    <loc>${absolute(path)}</loc>\n  </url>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}${extraEntries ? `\n${extraEntries}` : ""}
</urlset>
`;
};
```

The controller's test calls `sitemap.index()` synchronously in Billet core, so it
needs awaiting once the controller returns a promise:

```ts
const response = await sitemap.index();
const body = await response.text();
```

A site that skips this step serves a sitemap with no CMS pages — the pages
themselves still work.

Canonicals and social tags come from `pageSeo` (fed into the site layout, as in
step 4) or, for a site that would rather emit a fragment, `renderSeoTags`. The
rules themselves are Billet's:
[`runbooks/SEO.md`](https://github.com/alexpricedev/Billet/blob/main/runbooks/SEO.md).

## 8. Allow the media bucket in the site's CSP

Uploads are served from your bucket, not from the site and not from the CMS, so
the site's `img-src` has to allow the bucket's origin. This is the failure that
looks like a code bug: the markup is correct, the `<picture>` is there, and the
browser blocks every request without saying anything on the page.

Billet core builds its policy in `src/server/utils/security-headers.ts`. Add the
origin from `MEDIA_PUBLIC_BASE_URL` — the same value the CMS is given:

```ts
const mediaOrigin = (): string => {
  const configured = process.env.MEDIA_PUBLIC_BASE_URL?.trim();
  if (!configured) return "";
  try {
    return new URL(configured).origin;
  } catch {
    return "";
  }
};

const CONTENT_SECURITY_POLICY = [
  // …
  `img-src 'self' data:${mediaOrigin() ? ` ${mediaOrigin()}` : ""}`,
  // …
];
```

Only the origin is used, so a bucket URL with a path or a trailing slash can't
produce a malformed header, and an unset or unparseable value contributes
nothing rather than breaking the policy. The CMS does the same thing for its own
policy, in `app/src/server/utils/security-headers.ts`.

Set `Cache-Control: public, max-age=31536000, immutable` on `media/*` as a
bucket rule. Object keys carry a UUID per upload and are never rewritten, so a
cached image can never go stale. Deleting an image removes the object but does
not purge a CDN edge; purge `media/<id>/…` by hand when a deletion has to take
effect immediately.

## 9. Environment

On the site:

| Variable | What |
|---|---|
| `CMS_URL` | The CMS origin, e.g. `https://cms.example.com`. The Edit content link, the sign-in route and the preview banner's editor link are hidden or disabled without it. |
| `DATABASE_URL` | The shared Postgres. The same value the CMS is given. |
| `MEDIA_PUBLIC_BASE_URL` | The bucket's public base URL, used here only to build `img-src`. Optional; without it, no CMS images. |
| `CMS_EXPORT_TOKEN` | Only for `cms:pull` in local or preview environments. Never in production. |

On the CMS (see [Deploying the CMS](../README.md#deploying-the-cms)): its own
`APP_URL`, the site's `SITE_APP_URL`, the same `DATABASE_URL`, and the `S3_*` /
`MEDIA_PUBLIC_BASE_URL` bucket settings. Uploads are refused, with a message,
until the bucket is configured.

## 10. Deploy order

**CMS first, then the site.**

1. The CMS boots and runs its `cms_` migrations. It writes
   `cms_meta.contract_version`, and creates `cms_identities` once the site's
   `users` table exists.
2. The site deploys and runs `bun run cms:publish`. The publish checks the
   contract version; before the CMS has booted it stops with a message naming the
   CMS, rather than writing definitions nothing can read.

The site's own migrations are untouched by all of this: the CMS only ever
creates `cms_`-prefixed relations (and the `cms_identities` view).

## 11. Check the install

After the first deploy of both sides:

- `bunx billet-cms-publish` prints the definition counts and a content version
  rather than a contract error.
- The site's `/cms/sign-in`, visited signed in as an admin, lands in the CMS
  editor; as a non-editor, it shows the 403 page.
- A page created in the CMS is served at its URL by the site, and appears in the
  site's `sitemap.xml`.
- A CMS image renders — check the browser's network tab for a CSP block if it
  doesn't (step 8).
- Preview from the CMS shows the draft on the real page with the banner, and
  publishing shows within a few seconds.

## Pulling content into local or preview

An admin creates an export token in the CMS (**Export**). Then, in the local
environment:

```bash
CMS_EXPORT_TOKEN=… bun run cms:pull --from https://cms.example.com
```

It replaces local `cms_` content with the CMS's published content — pages, slots,
published revisions, redirects and media rows. It is one-way, carries published
content only (no drafts, users, sessions or tokens), keeps production image
URLs, and refuses to run under `NODE_ENV=production`. Because it replaces local
content wholesale, local drafts are discarded.

Add the script to the site's `package.json`:

```json
"cms:pull": "billet-cms-pull"
```

## Where to go next

[`packages/billet-cms/README.md`](../packages/billet-cms/README.md) is the API
reference for what each helper does: the field vocabulary, the read helpers and
their cache, preview, images, export and pull. `runbooks/SANDBOX.md` covers
running a site and the CMS together locally with fixture content.
