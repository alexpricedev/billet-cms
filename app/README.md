# Billet CMS — the service

`app/` is the CMS service of [billet-cms](../README.md): its own web app, on its
own host (`cms.<domain>`), sharing the site's PostgreSQL database.

The site declares its blocks, slots and page types in code and publishes them
into `cms_`-prefixed tables on deploy; the CMS builds its forms from those rows
and never imports site code. It has **no sign-in of its own**: a signed-out visit
is handed to the site's Billet app, which mints a single-use handoff token the
CMS spends to start a session. It stores no account and no password.

- The invariants live in [`../AGENTS.md`](../AGENTS.md).
- [`CLAUDE.md`](CLAUDE.md) is the guidance for agents working in this directory.
- The workspace [`../README.md`](../README.md) covers installing the plugin,
  deploying the CMS, and pulling content into local or preview.

## Working on it

A Bun app inside the `billet-cms` workspace. Everything runs through the root
scripts:

```bash
bun install
bun run check     # lint + typecheck across the workspaces
bun run build     # the CMS client bundles
bun run test      # app suite, plugin suite, then the end-to-end suite
```

Before a change is done, run `bun run check` and `bun run test` from the
workspace root; there is no pre-commit hook, so CI is the only gate and nothing
local will run for you. The browser smoke tests
(`bun run --cwd app --env-file=../.env.test test:browser`) cover what happy-dom
can't and are worth running after a change to `layouts.tsx`,
`security-headers.ts` or `src/client/`.

Migrations run at boot, inside one transaction that first takes a Postgres
advisory lock, so any number of instances booting at once apply each migration
exactly once (`src/server/database/migrate.ts`).

## Environment

All required unless marked optional. See [`.env.example`](.env.example) for the
commented list.

| Variable | What |
|---|---|
| `DATABASE_URL` | The shared Postgres — the same database the site uses. |
| `CRYPTO_PEPPER` | Secret key for session and CSRF tokens. |
| `APP_URL` | The CMS's own origin, including the port. CSRF origin validation compares the request `Origin` against it exactly. |
| `SITE_APP_URL` | The site's own Billet app, where sign-in happens. Required: the CMS cannot sign anyone in without it. |
| `APP_NAME` | Display name. |
| `PORT` | Server port. |
| `SITE_URL` | *Optional.* Canonical origin for canonicals, Open Graph, the sitemap and JSON-LD. Defaults to `APP_URL`'s origin. |
| `ALLOW_INDEXING` | *Optional.* `true` lets search engines index the CMS. Unset, every response says `noindex`. |
| `SESSION_COOKIE_NAME` | *Optional.* Defaults to `cms_session`. |
| `SECURITY_CONTACT` | *Optional.* Contact for `/.well-known/security.txt`. |
| `TRUST_PROXY` | *Optional.* `true` behind one reverse proxy that rewrites `x-forwarded-for`. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MEDIA_PUBLIC_BASE_URL` | *Optional.* Configure the media bucket; uploads are refused until they are set. `S3_REGION` / `S3_ENDPOINT` when the provider needs them. |

## Layout

```
src/
├── client/                 # Browser-side code
│   ├── main.ts             # Entry point — registers pages and components
│   ├── cms-form.ts         # The generated CMS form's client half (the one client-JS exception)
│   ├── page-lifecycle.ts   # Page init/cleanup system
│   ├── reactive/           # Signals, components and the form submit helper
│   ├── style.css           # CSS entry point — @import manifest
│   └── pages/              # Page-specific JS + CSS
│
├── server/
│   ├── main.ts             # Server entry point
│   ├── routes/             # app.tsx (HTML), api.ts (JSON)
│   ├── controllers/
│   │   ├── app/            # Origin landing page, robots/sitemap/llms/security.txt, the forms demo
│   │   ├── api/            # Stats endpoint, request guard
│   │   ├── auth/           # Sign-in handoff, /handoff, account, logout
│   │   └── cms/            # The CMS surface: pages, slots, media, export tokens
│   ├── templates/          # Full-page JSX templates (incl. templates/cms/)
│   ├── components/         # Reusable server JSX
│   ├── services/           # Content, media, export, handoff, sessions, auth
│   ├── middleware/         # Auth, CSRF, rate limiting
│   └── database/           # Migrations and CLI
│
└── shared/                 # The data-* vocabulary and header names both sides import

scripts/
├── wip                     # Per-worktree WIP snapshots (safe `git stash` replacement)
├── benchmark.ts            # Times the suite, checks and build
├── browser-smoke.test.ts   # Real-browser smoke test — its own CI job
└── workspace.ts            # Per-workspace port + dev/test databases

.claude/                    # Agent rules, hooks and skills for this directory
runbooks/                   # Operational standards — SECURITY, PRIVACY, ACCESSIBILITY, SEO, CI, RELEASE
```

## Sign-in

There is no `/login`, no password form and no email delivery in this app. A
signed-out visit to a guarded page is redirected to `/sign-in`, which sends the
browser to `<SITE_APP_URL><CMS_SIGN_IN_PATH>` — a route the site mounts from the
plugin (`handleCmsSignIn`). That route resolves the site's own signed-in user,
checks them against `cms_identities`, and mints a single-use 60-second token
that the CMS's `/handoff` route spends to start a session. The CMS never inserts
into, updates or deletes the site's `users`, and never reads or writes password
data.

## The database is the runtime contract

Block, slot and page definitions live in site code and are published into `cms_`
rows on deploy; the CMS never imports site code. Every relation the CMS creates
is `cms_`-prefixed, because it shares the database with the site's own Billet
app. `cms_meta` holds `contract_version` (written at boot) and
`content_version` (bumped on publish, polled by the plugin).
`packages/billet-cms/src/contract` is the single source of truth for the names.
