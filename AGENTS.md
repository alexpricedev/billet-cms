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
  `bun run build`. They delegate into the workspaces. `bun run dev` starts the
  CMS with the root `.env` passed down with `--env-file`: nothing inside `app/`
  loads it on its own.
- A Conductor workspace gets its own port and its own two databases.
  `.conductor/settings.toml` runs `scripts/workspace.ts provision` on setup and
  `destroy` on archive; it rewrites the root `.env` (`PORT`, `APP_URL`,
  `DATABASE_URL`, `SESSION_COOKIE_NAME`) and `.env.test`'s `DATABASE_URL` with
  names carrying the workspace's slug. Never hardcode a port or a database name
  — read them from the env.
- `app/CLAUDE.md` is Billet's own guidance and still applies inside `app/`
  unless this file says otherwise.
- `app/.github/` came in with the verbatim Billet v5.1.0 copy and is inert:
  GitHub reads workflows, PR templates and dependabot only from the repository
  root, so `.github/` here is what runs.
- Never connect to a database other than the one named in `.env` /
  `.env.test`.
- Reviewers: read `REVIEW.md` first — what failure looks like here, the nit cap,
  paths to skip.

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
  (password or magic link — the site's choice) first. **Known limitation:** a
  handoff token names the identity it was minted for, but a browser already
  signed in as a *different* admin is redirected from `/handoff`'s GET to `/cms`
  with its existing session, and the token simply expires unspent. Becoming the
  token's admin therefore needs a direct POST (which does replace the session,
  so the browser silently becomes the second person), and there is deliberately
  no "continue as X" confirmation step. Everyone the CMS can sign in is already
  an admin the site put in `cms_identities`.
  The CMS never inserts into, updates or deletes `users`, and never reads or
  writes password data. There is
  no `cms_users` table (Phase 3 dropped it) and no CMS magic-link sign-in (review
  round 4 removed it). A session stores the site user's id and re-reads the view
  on every request, so a site that removes an account ends the session at the
  next request. There is no CMS account to provision.
- **Two recorded exceptions to server-rendered interaction, and no more.**
  `src/client/components/preview-guard.ts` is the smaller one: Preview mints a
  token for the last *saved* revision, so pressed with unsaved edits on screen
  it shows older words and says nothing about why. The guard marks the form
  dirty on the first edit and, on a Preview pressed while it is dirty, asks
  first and offers the save. It reads no state of its own — a dirty flag, a
  hidden input and a `requestSubmit` — and with JavaScript off Preview posts
  exactly as it always did. It lives outside `cms-form.ts` because that bundle
  has a byte budget (`client/boundaries.test.ts`) and this is page chrome, not
  content serialisation.

  The larger one: **the generated CMS form.**
  `src/client/cms-form.ts` is shipped for the block editor and
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
  view; a preview bypasses the `content_version` cache for the token's own
  subject only, so the other slots on the page stay cached.

  Two things hang off that. The banner names **when the draft was saved**
  (`PreviewAccess.draftSavedAt`, read in the same query as the token), which is
  what lets an editor looking at words they did not type work out why. And a
  save carrying `after=preview` — the preview guard's doing — finishes by
  minting the token and redirecting on to the site rather than returning to the
  form: a save is a navigation, and a `target="_blank"` submitted after one has
  no user gesture behind it, so the tab it would open is blocked. That path
  lands in the same tab on purpose; the banner's "Back to the editor" is the
  way back.
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

  Both of those read the **field metadata tree**, through `collectReferences` in
  `services/media/guidance.ts`, and both are only as deep as that walk. It has
  to follow a `list`'s `of` and a `group`'s `fields`, on the item's *value* —
  a list item is a bare value with no key to look itself up by, and getting
  that wrong once meant `image()` inside `list()` collected zero references, so
  neither the guidance nor the deleted-image refusal fired for a gallery.
  `guidance.test.ts` pins every nesting. The delete protection is the one that
  was never affected: it walks stored values (`collectMediaIds`), not metadata.

  The drivers (S3, the sandbox's local disk, the tests' memory store) come
  from `@alexpricedev/billet-storage`; `app/src/server/services/media/storage.ts`
  keeps only the CMS's own choice between them, which refuses uploads rather
  than falling back to disk when no bucket is set.
  The site renders one through `<CmsImage>` (`renderCmsImage`, reading the row
  with `getMedia`). The bucket is configured with `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `MEDIA_PUBLIC_BASE_URL` (plus
  `S3_REGION` / `S3_ENDPOINT` when the provider needs them); uploads are simply
  refused, with a message, until they are set. A site's CSP `img-src` must
  allow the bucket host.
- **The sandbox and fixtures are dev-only.** The loader is the one thing besides the
  e2e suite that writes the site's `users`. `bun run sandbox`, `bun run fixtures` and
  `scripts/persona-session.ts` load Northwind Studio's people and content onto a
  local database, which means truncating the fixture site's `users` as well as the
  CMS's `cms_` content tables. Each refuses under `NODE_ENV=production` and
  unless the `DATABASE_URL` host is `localhost`, `127.0.0.1` or `::1`
  (`FIXTURES_ALLOW_REMOTE=1` overrides the host check), and runs that check
  *before* importing anything that opens a database pool
  (`scripts/sandbox-guard.ts`). Never run the loader against a real site's
  database. `MEDIA_LOCAL_DIR` is the same kind of seam: a local-disk media store
  for dev and tests, ignored in production. `runbooks/SANDBOX.md` has the commands,
  the personas and the fixture-to-story map.

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
the `csrfTokens` helper (`utils/csrf-tokens.ts`); the email-verification
banner and flow; `templates/accept-invite.tsx`. The CMS
itself then lost its own sign-in: the magic-link login (`/login`,
`/auth/callback`, the email service and its Resend provider, the captcha and
honeypot that guarded the form) is gone, and sign-in goes through the site —
see the invariant above. A later port also has to drop the starter **Forms
demo** that shipped on top of the fork: the `/forms` route,
`controllers/app/forms.tsx`, `templates/forms.tsx`, `client/pages/forms.ts` and
`forms.css` are all gone. It was a public, CSRF-protected POST endpoint the CMS
never needed, and nothing links to it. `components/form-field.tsx`,
`utils/form-action.ts`, `utils/form-data.ts` and `form-field.css` stay even
though nothing imports them: they are unused upstream helpers kept so a future
port diffs cleanly, not part of the demo page.

**Moved to the repository root.** `scripts/workspace.ts` and
`.conductor/settings.toml` arrived inside `app/` with the upstream copy and are
gone from there: Conductor reads `.conductor/` from the repository root only,
and the env files this repository provisions are the root `.env` and
`.env.test`, not an `app/.env` that does not exist. When porting a later
upstream release, apply its changes to both files at the root rather than
restoring the `app/` copies.

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
