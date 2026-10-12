# AGENTS.md

Billet CMS, a headless CMS for Billet sites. It is a Bun workspace:

- `app/` — the CMS service. A fork of Billet v5.1.0 that runs on `cms.<domain>`
  and shares the site's Postgres database.
- `packages/billet-cms` — the block plugin sites install and the contract both
  sides share (`./contract`).

The spec and the decisions behind it live on the parent ticket, not in this
repo. This file is only the invariants.

## Working agreements

- Run everything through the root scripts: `bun run check`, `bun run test`,
  `bun run build`. They delegate into the workspaces.
- `app/CLAUDE.md` is Billet's own guidance and still applies inside `app/`
  unless this file says otherwise.
- `app/.github/` came in with the verbatim Billet v5.1.0 copy and is inert:
  GitHub reads workflows, PR templates and dependabot only from the repository
  root, so `.github/` here is what runs.
- Never connect to a database other than the one named in `.env` /
  `.env.test`.

## Invariants

- **Every relation the CMS creates is `cms_`-prefixed** — tables, views,
  sequences, indexes and constraints alike. The CMS shares its database with the
  site's own Billet app, so an unprefixed name is a collision waiting to happen.
  `packages/billet-cms/src/contract/index.ts` is the single source of truth for
  the names.
- **`cms_migrations`, not `migrations`.** The site's app already has a
  `migrations` table.
- **Migrations run at boot**, inside one transaction that first takes a Postgres
  advisory lock, so any number of instances booting at once apply each migration
  exactly once. `runMigrations` in `app/src/server/database/migrate.ts`.
- **`cms_meta` is one row** (`id = 1`): `contract_version` is written by the CMS
  at boot; `content_version` is bumped on publish and polled by the plugin.
- **`cms_identities` is a view the CMS creates only if it is missing, and never
  replaces.** The site owns its definition (the default is the site's admins).
  A site migration that drops or retypes `users.id`, `users.email` or
  `users.role` must `DROP VIEW cms_identities` first — Postgres refuses the
  change while the view depends on the column — and the CMS rebuilds the default
  on its next boot; a site with its own definition recreates it in the same
  migration. `app/src/server/database/identity-view.ts`.
- **The contract version is `CONTRACT_VERSION`** in
  `packages/billet-cms/src/contract`. Bump it whenever stored rows change shape
  in a way an older CMS or site cannot read.
- **The database is the runtime contract, not the source of truth.** Block and
  page definitions live in site code and are published into `cms_` rows on
  deploy; the CMS never imports site code.

## Porting Billet upgrades

`app/` was landed as Billet v5.1.0 verbatim and then stripped and renamed.
`app/.billet-version` records which upstream release the tree came from — never
rename, strip or delete it, and bump it only when porting an upstream release
(D9).

To port an upstream release, diff against the tag and apply the changes on top
of this fork. The strip and the renames are the things that will conflict:

**Removed from upstream.** Todos (the demo resource); organisations and teams
(`organizations`, `organization_members`, `organization_invites`, `invites.ts`,
`teams-mode.ts`, the `/team` and `/invites` surfaces); password auth
(`passwords.ts`, password reset, `AUTH_MODE`); the user admin dashboard
(`/admin`, `middleware/admin.ts`); the seed script; Husky hooks; `scripts/qa-session.ts`;
the email-verification banner and flow; `templates/accept-invite.tsx`.

**Renamed to `cms_`.** `users` → `cms_users`, `sessions` → `cms_sessions`,
`user_tokens` → `cms_user_tokens`, `migrations` → `cms_migrations`. Indexes
carry the prefix first and end in `_idx`: `idx_sessions_user_id` →
`cms_sessions_user_id_idx`, and so on. The prefix has to come first so a
relation the CMS owns is recognisable in a list of `pg_class` names, and the
trailing `_idx` matches the site's own Billet app rather than an `idx_` prefix.
The migration files were rewritten against the new names and now also create
`cms_meta`; upstream migrations that add the removed columns do not apply.

**Kept, but on a renamed table.** Magic-link sign-in is unchanged apart from the
table names. It still authenticates against `cms_users` in this phase; Phase 3
moves sign-in onto the site's accounts through `cms_identities` and drops
`cms_users`.
