# Changelog

## 0.2.0

`group()` is the headline: a block can declare a repeated pair instead of two
parallel lists that leave nothing tying one row to the other. The contract
version moves to `0.8.0` with it, so deploy the CMS before the site, as always.
The rest is the read path costing fewer queries, a preview that explains itself,
and a handful of tightenings whose whole story is in the entries below.

**Deploy the CMS first.** A site on this version publishes `group` metadata an
older CMS has no control to render.

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

### The read path costs one query, and one poll serves a pool

Reading a slot took three queries — the slot row, its block type and its
revision — and the first read after a publish paid for all three. `loadSlot`
joins them, so a cold slot costs one, and the preview path reuses that same read
and validation.

The page, slot and media readers each owned a `ContentCache`, which meant a site
that mounts the catch-all *and* reads slots asked `cms_meta` for
`content_version` once a second per reader. `ContentVersion` is that poll on its
own, and `contentVersionFor(sql)` hands every reader on a pool the same one, so
the steady state is one `cms_meta` query a second in total; `invalidate()` on any
reader resets the shared poll, so the next read from any of them goes back to
the database.

Simultaneous misses share their work too — one version read, one load per key —
and the sharing is scoped to the generation in flight, so a load that started
before a publish is neither stored nor handed to a caller reading the newer
version. A preview keeps the cache for every subject but the token's own:
opening a slot preview no longer re-reads the routing table, and the other slots
on the page stay cached.

**Nothing for a site to change.** A site that builds its own `ContentCache` may
pass the shared `version` instead of `readVersion`; the old shape still works.

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

### A preview response says `no-referrer`, and the banner links back

A preview URL holds the raw token for its whole half hour. `applyPreview` now
sends `Referrer-Policy: no-referrer`, so the page's subresources — an analytics
script, a third-party font — and the links out of the draft don't hand that URL
to anyone in `Referer`.

`renderPreviewBanner` also adds a "Back to the editor" link, built from
`CMS_URL` (the same variable `createEditContentLink` reads) and the token's
subject. A site without `CMS_URL` gets the banner it had before, and only an
http(s) origin is accepted, so a bad value can't become a `javascript:` URL.

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

### A refused sign-in is a page, with a way back

The refusal a signed-in non-editor gets from `handleCmsSignIn` is now a small
HTML page (same sentence, who to ask, a Back to the site link), still a 403
with no token written. A new optional `renderRefusal` option lets the site
render its own; its status is forced to 403.

**Nothing for a site to change.** The 403 body changes from plain text to HTML.

### A `required` the compiler cannot resolve is maybe-absent

`FieldValue` decided presence by testing `O extends { required: false }`, which
is unsound when `required` is a plain `boolean`: a field declared through a
variable typed `FieldOptions` produced a value the compiler treated as always
present. The test is now whether the option type carries `required: true`, so an
inline `text({ required: false })` still gives `string | undefined`, an
optionless `text()` still gives `string`, and a flag the compiler cannot resolve
gives `T | undefined`.

A site whose render function takes a field declared that way may have to handle
an `undefined` it was being told could not happen. Page content also reads as a
discriminated union keyed on `type` now, so a page's `blocks` type narrows on
the block it holds; no stored document or published schema changes.

### The alt override on an image is capped at `MAX_ALT_LENGTH`

An `image()` value's `alt` override was an unbounded string while the upload's
own alt was capped at 1000 characters, so `{ mediaId, alt }` could store a
paragraph that every page reusing the picture rendered into its `alt`
attribute. `MAX_ALT_LENGTH`, exported from the contract, is now the cap in both
places: `image()` compiles it to `maxLength` in the published JSON Schema, and
the CMS refuses a longer value at save with the limit the site's own schema
enforces.

A stored override over the cap now fails its read like any other invalid
content, so a block holding one falls back until an editor shortens it.

### A slot name is dot-separated segments, and rich text is depth-checked

`SLOT_NAME_PATTERN` was one character class with `.` allowed anywhere, so
`"home..hero"`, `".hero"` and `"home."` all passed and then named a page the CMS
could never match. The pattern is anchored per segment now, with the whole name
capped at 64 characters like a single-segment one, and `slot()` checks its
`page` option the same way, so a typo is caught beside the declaration. A site
using a name of that shape has to fix it when its config loads.

A rich text document nested deeper than `MAX_RICH_TEXT_LIST_DEPTH` (8) lists is
refused when content is validated rather than overflowing the stack inside the
recursive parse: the stored JSON Schema leaves the recursion unbounded, so the
depth is checked on the raw value first, without recursion.

### The CLIs say more, and ask for the pull token in the environment

`billet-cms-pull`'s help and error text name `CMS_EXPORT_TOKEN` before
`--token` — a flag lands in shell history and in a process listing, and the
token reads everything published — and `--token` still works.
`billet-cms-publish` prints the whole error, stack and all, for a failure it has
no written message for, instead of a one-line message that hides the cause.

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
