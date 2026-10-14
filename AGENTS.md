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
- **The CMS has no sign-in of its own; signing in always goes through the
  site.** A signed-out visit to a guarded page is sent to `/sign-in`, which
  redirects to `<SITE_APP_URL><CMS_SIGN_IN_PATH>` — a route the site mounts from
  the plugin (`handleCmsSignIn`, `packages/billet-cms/src/sign-in`).
  `SITE_APP_URL` is required: the CMS cannot sign anyone in without it, so
  `validateEnv` refuses to boot when it is missing or not a valid http(s) URL
  (`utils/env.ts`). That route resolves the site's own signed-in user, checks
  them against `cms_identities`
  (the view over the site's `users`; the default exposes its admins), and, for an
  identity, writes a single-use 60-second token into `cms_handoff_tokens` and
  sends the browser back to the CMS's `/handoff`, which spends it and starts a
  `cms_session`. A site user who is not in the view is refused with a 403 and
  gets no token; someone signed out on the site goes through the site's own login
  (password or magic link — the site's choice) first. The CMS never inserts into,
  updates or deletes `users`, and never reads or writes password data. There is
  no `cms_users` table (Phase 3 dropped it) and no CMS magic-link sign-in (review
  round 4 removed it). A session stores the site user's id and re-reads the view
  on every request, so a site that removes an account ends the session at the
  next request. There is no CMS account to provision.
- **The generated CMS form is the one recorded exception to server-rendered
  interaction.** `src/client/cms-form.ts` is shipped for the block editor and
  the media focal-point picker: rich text is a `contenteditable` editor,
  repeatable lists are added and removed without a round trip, and the image
  field's picker writes the chosen id into the media-id input. The server
  renders the stored document into the page and the script only walks that DOM
  back into a hidden `content` field (and, on a media form, moves the focal
  marker and the previews), so with JavaScript off the form still submits the
  stored content unchanged. Keep it to that: no fetching, no `JSON.parse`, no
  markup built from data — the same rules `client/boundaries.test.ts` enforces.
- **Preview is a token row, not an API.** `cms_preview_tokens` holds a hashed,
  30-minute, single-subject token (a page or a slot). The CMS mints one and opens
  `<SITE_APP_URL><path>?cms_preview=…`; the plugin
  (`packages/billet-cms/src/preview`, re-exported from `./server`) checks it and,
  for that subject only, renders the newest draft with a Preview banner and
  `Cache-Control: no-store` / `X-Robots-Tag: noindex`. A slot's `previewPath`
  (declared on `slot()`, published to `cms_slots.preview_path`) is the site page
  the CMS opens for it. An unknown, expired or missing token is the published
  view; a preview read always bypasses the `content_version` cache.
- **Media lives in an S3-compatible bucket, behind `cms_media`.** The CMS
  uploads an image once (JPEG, PNG or WebP, sniffed from its bytes — SVG and
  animated GIF are refused), caps it at 20 MB and 100 megapixels, applies EXIF
  rotation then strips all metadata (GPS included), and stores a WebP plus a
  fallback at every fixed width the source can fill (`MEDIA_WIDTHS`, never an
  upscale). The row keeps the object keys and the public URLs, so the site needs
  no bucket configuration. `image()` guidance (`minWidth`, `aspect`) is enforced
  when content is *saved*, not at upload — the same picture is a hero in one
  block and a thumbnail in another. Alt text is required, a use may override it,
  an image referenced by any **published** page or slot cannot be deleted, and
  publishing a draft that names a deleted image is refused with "This image was
  deleted. Choose another." on the block (a save of that draft still succeeds, so
  the editor can pick another).
  The site renders one through `<CmsImage>` (`renderCmsImage`, reading the row
  with `getMedia`). The bucket is configured with `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `MEDIA_PUBLIC_BASE_URL` (plus
  `S3_REGION` / `S3_ENDPOINT` when the provider needs them); uploads are simply
  refused, with a message, until they are set. A site's CSP `img-src` must
  allow the bucket host.

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
the email-verification banner and flow; `templates/accept-invite.tsx`. The CMS
itself then lost its own sign-in: the magic-link login (`/login`,
`/auth/callback`, the email service and its Resend provider, the captcha and
honeypot that guarded the form) is gone, and sign-in goes through the site —
see the invariant above.

**Renamed to `cms_`.** `users` → `cms_users`, `sessions` → `cms_sessions`,
`user_tokens` → `cms_user_tokens`, `migrations` → `cms_migrations`. Indexes
carry the prefix first and end in `_idx`: `idx_sessions_user_id` →
`cms_sessions_user_id_idx`, and so on. The prefix has to come first so a
relation the CMS owns is recognisable in a list of `pg_class` names, and the
trailing `_idx` matches the site's own Billet app rather than an `idx_` prefix.
The migration files were rewritten against the new names and now also create
`cms_meta`; upstream migrations that add the removed columns do not apply.

**Kept, but on a renamed table.** `cms_users` was created by the
verbatim-copy milestone and dropped by migration `009_identities_and_handoff.ts`:
sign-in now reads the site's own accounts through `cms_identities`,
`cms_sessions.user_id` and `cms_user_tokens.user_id` name an identity, and there
is no foreign key because the view's rows belong to the site. `cms_user_tokens`
is the magic-link token table the fork inherited; the CMS's own magic-link
sign-in is gone (review round 4), so nothing writes it now, but it is left in
place as migration history rather than dropped. When porting an upstream
release, the sign-in service (`services/auth.ts`) will conflict where upstream
reads `cms_users` and mints magic links; this fork keeps only the identity
lookup and session helper, and sign-in goes through the plugin's handoff route.
