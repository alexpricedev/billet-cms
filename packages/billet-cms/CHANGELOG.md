# Changelog

## Unreleased

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
