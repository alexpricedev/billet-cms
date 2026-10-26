# billet-cms

A headless CMS for [Billet](https://github.com/alexpricedev/Billet) sites. Three things live here:

| Path | What it is |
|---|---|
| `app/` | The CMS service — its own web app on `cms.<domain>`, connected to the site's Postgres. A fork of Billet v5.1.0. |
| `packages/billet-cms` | `@alexpricedev/billet-cms`, the block plugin sites install. Holds the field vocabulary, the site-side read helpers and the contract both sides share. |
| `e2e/` | A small Bun site (also the sandbox's Northwind Studio) and the end-to-end suite that proves the whole thing works. |
| `fixtures/`, `scripts/` | The fixture data, loader and sandbox commands. See `runbooks/SANDBOX.md`. |
| `runbooks/` | Installing the CMS in a site (`INSTALLING-IN-A-SITE.md`) and the sandbox (`SANDBOX.md`). |

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
bun run dev       # the CMS on PORT from .env, client bundles watched
bun run check     # lint + typecheck across the workspaces
bun run build     # the CMS client bundles
bun run test      # app suite, plugin suite, then the end-to-end suite
bun run e2e       # just the end-to-end suite
```

`.env` points the CMS at a database; `.env.test` is the suite's. Never point
either at another project's database — the CMS shares a database by design, and
its migrations and truncations must stay inside the `cms_` (and test `users`)
tables.

Each Conductor workspace is provisioned for itself: `.conductor/settings.toml`
runs `scripts/workspace.ts provision` on setup and `destroy` on archive, which
gives the workspace its own port and its own `<base>-<workspace>` dev database
and `<base>_test-<workspace>` test database, then writes them into the root env
files. That is what makes `run_mode = "concurrent"` safe. Both commands no-op in
cloud workspaces.

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

A site adds `@alexpricedev/billet-cms`, declares its blocks, slots and page types
in `cms.config.ts`, and publishes them on deploy. It then mounts the plugin's
page catch-all and its `/cms/sign-in` route, merges CMS pages into its own
sitemap, and allows the media bucket in its CSP.

The walkthrough — the code for each step, the environment, and the deploy order
— is [`runbooks/INSTALLING-IN-A-SITE.md`](runbooks/INSTALLING-IN-A-SITE.md).
[`packages/billet-cms/README.md`](packages/billet-cms/README.md) is the API
reference for the package itself.

## Pulling content into local or preview

An admin creates an export token in the CMS (**Export**). Then, in the local
environment:

```bash
# Set CMS_EXPORT_TOKEN rather than passing --token, so the secret doesn't land
# in your shell history or a process listing.
CMS_EXPORT_TOKEN=… bun run cms:pull --from https://cms.example.com
```

It fetches the CMS's published content and replaces local `cms_` content with
it. It is one-way and carries **published content only** — the export never
contains drafts, users, sessions or tokens — but because it replaces local
pages, slots and revisions wholesale, **it also discards local drafts**, so
anything unpublished in the local CMS is gone after a pull. Images keep the
production bucket's URLs, and it refuses to run under `NODE_ENV=production`.

## Releasing the plugin

`@alexpricedev/billet-cms` is published to public npm by
`.github/workflows/release.yml` when its version tag is pushed. TypeScript
source, no build step: what ships is `src/`, `README.md`, `CHANGELOG.md` and
`LICENSE`.

To release:

1. In a PR, bump `version` in `packages/billet-cms/package.json` and add a
   matching `## <version>` section at the top of
   `packages/billet-cms/CHANGELOG.md`. Merge it.
2. Tag the merged commit on main and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag @alexpricedev/billet-cms@<version>
   git push origin @alexpricedev/billet-cms@<version>
   ```

The workflow then:

- checks the tag matches `package.json`, the CHANGELOG has that section, the
  commit is on main and the version isn't already on npm
- runs the full CI (lint, typecheck, build, tests, browser smoke tests)
- publishes to npm through trusted publishing (no npm token anywhere;
  provenance is added automatically)
- creates a GitHub release whose notes are that CHANGELOG section

If any check fails, nothing is published. Fix it, delete the tag
(`git push origin :refs/tags/@alexpricedev/billet-cms@<version>` and
`git tag -d …`), and tag again.

To see what would ship before tagging:

```bash
bun pm pack --dry-run --cwd packages/billet-cms
```

## End-to-end tests

`e2e/` is a minimal Bun test site — a real `Bun.serve` that reads the shared
`cms_` tables through the plugin, exactly as a real site would. The suite
(`bun run e2e`) publishes the site's definitions, signs an admin in to a real CMS
subprocess, edits a slot's content and an image, previews the draft, publishes
it, and checks the site serves it — and keeps serving it after the CMS process
is stopped.

## The sandbox

`bun run sandbox` starts a fixture site (Northwind Studio, grown from `e2e/`)
and the CMS together on one local database, loaded with the same people and
content every time, so a person or an agent can sign in as a persona and run
the stories in `ux/stories/`. `bun run fixtures` only reloads the data, and
`bun run scripts/persona-session.ts <persona> --side site|cms` prints a session
cookie. Both commands refuse under `NODE_ENV=production` and for any database
host that isn't local. See [`runbooks/SANDBOX.md`](runbooks/SANDBOX.md).
