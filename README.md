# billet-cms

A headless CMS for Billet sites. Three things live here:

| Path | What it is |
|---|---|
| `app/` | The CMS service — its own web app on `cms.<domain>`, connected to the site's Postgres. A fork of Billet v5.1.0. |
| `packages/billet-cms` | `@alexpricedev/billet-cms`, the block plugin sites install. Holds the field vocabulary, the site-side read helpers and the contract both sides share. |
| `e2e/` | A minimal Bun test site and the end-to-end suite that proves the whole thing works. |

The CMS is never on the public site's request path. A site declares its blocks,
slots and page types in code and publishes them into `cms_` tables on deploy;
the CMS builds its forms from those rows and never imports site code. Both sides
share one Postgres database, so **every relation the CMS creates is
`cms_`-prefixed** — the site's own Billet tables are untouched.

The spec and the decisions behind it live on the project's ticket, not in this
repo.

## Working on it

A Bun workspace. Everything runs through the root scripts:

```bash
bun install
bun run check     # lint + typecheck across the workspaces
bun run build     # the CMS client bundles
bun run test      # app suite, plugin suite, then the end-to-end suite
bun run e2e       # just the end-to-end suite
```

`.env` points the CMS at a database; `.env.test` is the suite's. Never point
either at another project's database — the CMS shares a database by design, and
its migrations and truncations must stay inside the `cms_` (and test `users`)
tables.

`AGENTS.md` holds the invariants (the `cms_` prefix, `cms_identities`,
migrations at boot, the contract version, the one client-JS exception). `app/`
is a Billet fork and `app/CLAUDE.md` still applies inside it.

## Deploying the CMS

The CMS is one Railway service per site, from this repo, connected to that
site's Postgres. `app/.railway/railway.ts` describes the service; the deploy
command is `bun install && bun run build` and the start command `bun run start`.

- **Deploy the CMS first, then the site.** The CMS runs its `cms_` migrations at
  boot and writes `cms_meta.contract_version`; the site's publish step checks it
  and stops with a clear message until the CMS is set up.
- `DATABASE_URL` is the site's Postgres, wired by reference.
- `APP_URL` is the CMS's own origin; `SITE_APP_URL` is the site's, and is
  required — the CMS has no sign-in of its own and sends a signed-out visit
  there.
- The media bucket is configured with `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY` and `MEDIA_PUBLIC_BASE_URL` (plus `S3_REGION` /
  `S3_ENDPOINT` when the provider needs them). Uploads are refused, with a
  message, until they are set.

## Installing the plugin in a site

```bash
bun add @alexpricedev/billet-cms
```

Declare the site's blocks, slots and page types in `cms.config.ts`, publish on
deploy with `bunx billet-cms-publish`, read content with
`@alexpricedev/billet-cms/server`, mount the fallback catch-all and the
`/cms/sign-in` route, and set `CMS_URL` so the Edit content link appears. The
full guide — the fallback hook, the sitemap hook, the CSP rule, the deploy order
and the environment — is in
[`packages/billet-cms/README.md`](packages/billet-cms/README.md#installing-in-a-site).

## Pulling content into local or preview

An admin creates an export token in the CMS (**Export**). Then, in the local
environment:

```bash
bun run cms:pull --from https://cms.example.com
# token from --token or CMS_EXPORT_TOKEN
```

It fetches the CMS's published content and replaces local `cms_` content with
it. It is one-way and carries **published content only** — the export never
contains drafts, users, sessions or tokens — but because it replaces local
pages, slots and revisions wholesale, **it also discards local drafts**, so
anything unpublished in the local CMS is gone after a pull. Images keep the
production bucket's URLs, and it refuses to run under `NODE_ENV=production`.

## Releasing the plugin

`@alexpricedev/billet-cms` is published to public npm by hand — TypeScript
source, no build step. Alex runs:

```bash
# 1. From a clean main, with the version bumped in packages/billet-cms/package.json
#    and a matching section written in packages/billet-cms/CHANGELOG.md.

# 2. Dry-run to see exactly what would ship (src/, README, CHANGELOG, package.json).
bun pm pack --dry-run --cwd packages/billet-cms

# 3. Log in (once per machine).
npm login

# 4. Publish. `publishConfig.access: public` is already set for the scoped name.
#    npm has no --cwd, so name the directory.
npm publish ./packages/billet-cms

# 5. Tag the release on the commit that carries the bump.
git tag @alexpricedev/billet-cms@0.1.0
git push origin @alexpricedev/billet-cms@0.1.0
```

Sites install a released version; the workspace version in this repo is the next
release's. There is no build step, so what is published is the `src/` here,
imported directly.

## End-to-end tests

`e2e/` is a minimal Bun test site — a real `Bun.serve` that reads the shared
`cms_` tables through the plugin, exactly as a real site would. The suite
(`bun run e2e`) publishes the site's definitions, signs an admin in to a real CMS
subprocess, edits a slot's content and an image, previews the draft, publishes
it, and checks the site serves it — and keeps serving it after the CMS process
is stopped.
