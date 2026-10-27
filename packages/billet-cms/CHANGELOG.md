# Changelog

## Unreleased

### The preview banner names when the draft was saved

`PreviewAccess` gains an optional `draftSavedAt`, read in the same query as the
token, and the banner prints it: "Preview — showing unpublished draft content.
This is not the live site. Draft saved 11 Jan 2026, 09:00 UTC."

It is there for one failure in particular. Preview mints a token for the last
*saved* revision, so an editor who types and presses Preview without saving
opens a tab showing their old words, with nothing on the page to explain it. A
time they can compare against the save they remember making turns that into
something they can reason about.

A site that forwards or fakes a `PreviewAccess` need not supply it — a banner
with no date is what this did before.

### `group()`, a nested object of other fields

`list()` repeats a single field, so a repeated pair — a card with a heading and
a body, a step with a title and a description — could not be declared: two
parallel lists leave nothing tying `titles[2]` to `bodies[2]`, and the editor
sees two unrelated controls. `list(group({ title: text(), body: text() }))` is
the shape those pages actually have.

A group is a field like any other: it holds an `image()`, it nests in another
group, and `BlockContent` types its value as a nested object. Nesting depth is
bounded by `MAX_LIST_DEPTH` across both kinds together, since the editor
recurses the metadata tree without caring which one nested it.

**The contract version is now `0.8.0`.** `FieldKind` gains `group` and
`FieldMetadata` gains `fields`, so an older CMS reading a published group has no
control to render it with. Deploy the CMS first, as always.

Two consequences for anything that walks the field metadata tree: it has to
follow `fields` as well as `of`, or it reads a group as a leaf and silently
ignores everything inside it. `Field` also gains an optional `readSchema`, which
composite fields set to a looser variant of their own schema: a group is strict
on save, because that is what becomes the stored JSON Schema, and tolerant on
read, because Q4 says a field a deploy dropped stays in the stored content and
must not break the block around it.

### Skips are throttled, and a reader types like the free function

`defaultSkipLogger` now reports each distinct message at most once a minute, and
`throttleSkips` is exported so a site passing its own `onSkip` can keep that.
Unthrottled, a site whose CMS is not set up yet logs one line per slot per
request, which buries the one line that matters later.

`ContentReader.getSlot` now carries the same overloads as the top-level
`getSlot`, so building a reader — the only way to pass `onSkip` — no longer
costs the content type inferred from `{ block }`.

### `block()`'s render function is optional

Nothing in this package ever called it, so a site that renders its blocks in
templates was writing a stub to satisfy the signature. The property is still
always present, defaulting to a no-op, so `definition.render(content)` keeps
typing for the sites that do use it.

The refusal a signed-in non-editor gets from `handleCmsSignIn` is now a small
HTML page (same sentence, who to ask, a Back to the site link), still a 403
with no token written. A new optional `renderRefusal` option lets the site
render its own; its status is forced to 403.

**Nothing for a site to change.** The 403 body changes from plain text to HTML.

## 0.1.1

The first release published by CI, through npm trusted publishing, so it
carries provenance. No code changes.

**Nothing for a site to change.**

## 0.1.0

First release. The block plugin a Billet site installs, and the contract the
site and the `billet-cms` service share.

**New package; no migration, and nothing an existing site has to change.**

### Added

- **The field vocabulary** (`text`, `richText`, `image`, `link`, `list`) and the
  block, slot and page-type builders (`block`, `slot`, `pageType`), each of
  which carries both the Zod schema stored content is validated against and the
  metadata the CMS builds its form from.
- **Publish on deploy** — `bunx billet-cms-publish` reads a site's
  `cms.config.ts` and writes its block types, page types and slots into the
  CMS's `cms_` tables as JSON Schema plus field metadata. It checks the
  contract version first and stops with a clear message when the CMS isn't set
  up or speaks a different version.
- **The site-side readers** (`@alexpricedev/billet-cms/server`): `getSlot`,
  `getPage`/`createCmsPageRoute` (the fallback catch-all, with 301s before
  pages), `listSitemapEntries`, `renderCmsImage` (`<CmsImage>`), and the rich
  text renderer. Reads are cached in memory and re-checked against
  `cms_meta.content_version` at most once a second.
- **Sign-in and the Edit content link** (`@alexpricedev/billet-cms/sign-in`,
  `./handoff`): `handleCmsSignIn` and `createEditContentLink` mint a single-use,
  short-lived token the CMS spends; the two services share the database and
  never a secret.
- **Preview** (`./preview`): `getPreviewAccess` reads the token the CMS put in
  `?cms_preview=`, and `applyPreview` adds the banner and the no-cache headers.
- **Export and pull** (`./cli/pull`, `bunx billet-cms-pull`): fetch a CMS's
  published content with an export token and replace local `cms_` content with
  it. One-way, refuses `NODE_ENV=production`, and images keep the production
  bucket's URLs.

### Notes

- The contract version this release speaks is `0.7.0`. The CMS service and the
  plugin must agree on it; publish checks.
