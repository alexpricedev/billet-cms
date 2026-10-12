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
- **CMS sign-in is invite-only, and the CMS never writes the site's accounts.**
  Magic-link sign-in looks a person up in `cms_identities`, the view over the
  site's own `users` table; an email the view does not expose — an unknown
  address, or a site user the default view keeps out because they are not an
  admin — creates no row, sends no link and starts no session, but gets the same
  "check your email" page a known one gets, so the form can't be used to
  enumerate accounts. The CMS never inserts into, updates or deletes `users`;
  there is no self-serve sign-up and no `cms_users` table (Phase 3 dropped it).
  A session stores the site user's id and re-reads the view on every request, so
  a site that removes an account ends the session at the next request. There is
  no CMS account to provision.
- **The generated CMS form is the one recorded exception to server-rendered
  interaction.** `src/client/cms-form.ts` is shipped for the block editor: rich
  text is a `contenteditable` editor and repeatable lists are added and removed
  without a round trip. The server renders the stored document into the page and
  the script only walks that DOM back into a hidden `content` field, so with
  JavaScript off the form still submits the stored content unchanged. Keep it to
  that: no fetching, no `JSON.parse`, no markup built from data — the same rules
  `client/boundaries.test.ts` enforces.

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

**Kept, but on a renamed table.** Magic-link sign-in is unchanged apart from
the table names. `cms_users` was created by the verbatim-copy milestone and
dropped by migration `009_identities_and_handoff.ts`: sign-in now reads the
site's own accounts through `cms_identities`, `cms_sessions.user_id` and
`cms_user_tokens.user_id` name an identity, and there is no foreign key because
the view's rows belong to the site. `cms_user_tokens` (the magic-link tokens)
is otherwise unchanged. When porting an upstream release, the sign-in service
(`services/auth.ts`) will conflict where it read `cms_users`; point it at
`cms_identities` as this fork does.
