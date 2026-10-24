# CLAUDE.md

> **This is the Billet CMS fork of Billet.** Read `../AGENTS.md` first: it lists
> what was removed from upstream (todos, teams, password auth, the user admin
> dashboard, the seed script, `scripts/qa-session.ts`) and which tables were
> renamed to `cms_`. Sections below that mention those features describe upstream
> Billet, not this app — `bun run seed` and `scripts/qa-session.ts` are gone.
>
> **Never write an unprefixed relation name.** This app shares its database with
> the site's own Billet app, so a query naming `sessions` or `users` reaches the
> *site's* table, not the CMS's. Every table, view, index and constraint the CMS
> creates is `cms_`-prefixed — see `../AGENTS.md` and
> `packages/billet-cms/src/contract` before adding one.

Billet is a server-rendered full-stack TypeScript app on Bun + PostgreSQL. Requests flow
route → controller → service → template. `README.md` has the directory tree; the code is the
spec for everything else. This file is for the things you can't learn by reading the repo.

## Working agreements

- The dev server is already running in another tab, on this workspace's own port — don't start
  one, and don't add a second. `bun run dev` here will fail on the port or fight the watcher.
  Read `PORT` from `.env` rather than assuming 3000; only the root checkout is on 3000.
- Run test and lint suites through the `package.json` scripts (`bun run test`, `bun run check`).
  Invoking `bun test` directly skips migrations, so it runs against whatever schema is already
  there — see the `verifying-changes` skill. The test environment itself is safe either way; it
  is pinned by a preload, not by the runner.
- Write code that reads like the surrounding code: match its comment density, naming, and idiom.
- When you try several approaches to a problem, delete the ones you abandoned before you finish.
- Check work in the browser with the `/browse` skill when the change is user-visible.
- A feature PR touches **none** of `CHANGELOG.md`, `package.json`'s `version`, or
  `.billet-version`. Releases are their own PR carrying exactly those three files —
  `runbooks/RELEASE.md`. Park changelog prose in `.context/` until then; a version heading written
  on a feature branch claims a version that doesn't exist yet.
- Never `git stash`. Use `bun run wip` — see "The stash is shared, the worktrees are not".

## Gotchas

### The stash is shared, the worktrees are not

This repo is usually several worktrees over one shared `.git`, and `refs/stash` lives in the
shared part — one global stack, so an agent that pops can silently take another agent's work.
`bun run wip` (`scripts/wip`) is the replacement: it snapshots to `refs/worktree/wip`, the one ref
namespace git keeps per-worktree. Run it bare for the subcommand list (`save`, `stash`, `list`,
`show`, `restore`, `drop`); `restore` applies without dropping, and untracked files are never
touched. A `PreToolUse` hook denies `git stash` and prints that same table; `git stash create` and
anything naming `refs/worktree/` pass through — that is how `scripts/wip` works.

### Each workspace owns its port and its two databases

`scripts/workspace.ts provision` (run by Conductor setup) rewrites this workspace's `.env` —
`PORT`/`APP_URL` from `CONDUCTOR_PORT`, a `DATABASE_URL` named `<base>-<workspace>`, a
workspace-specific `SESSION_COOKIE_NAME` — and gives `.env.test` its own `DATABASE_URL`, because
`cleanupTestData` truncates every table and two agents sharing one test database fail each other's
suites in ways neither can reproduce. A workspace port must never reach the tests: they hardcode
`http://localhost:3000` and build the expected CSRF Origin from `APP_URL`. `provision` is
idempotent (the base name comes from the root checkout's `.env`); `destroy` refuses to drop a
database that doesn't carry this workspace's slug. Both no-op in cloud workspaces.

### The dev database is shared with the site

One workspace, one `DATABASE_URL`, and it is the *site's* database: the CMS
creates only `cms_`-prefixed relations plus the `cms_identities` view over the
site's `users`, and must never truncate or rewrite a site table. Use the test
database (`.env.test`, its own `DATABASE_URL`, truncated between tests) for
anything that writes. To exercise a guarded page by hand, sign in through the
site and the `/handoff` flow — the upstream `scripts/qa-session.ts` helper is
gone with the CMS's own sign-in.

`DELETE FROM` without a predicate is never right here. Neither is reading the
human's cookie out of their browser instead of going through sign-in: it works,
and it makes the agent's requests indistinguishable from the developer's in the
logs.

### JSX is a server-side template engine, nothing more

Everything compiles with Preact (`jsxImportSource: preact` in `tsconfig.json`) — there is no React
in this project, and no Preact reaches the browser either. `src/server/` renders once through
`renderToString()` from `preact-render-to-string` and ships HTML. It never hydrates, so `useState`
in a template does nothing, and nothing in `src/client/` imports `preact`. `preact` is still a
runtime **dependency**, not a devDependency: the server imports its JSX runtime, so a production
install without it won't boot.

**Write SVG attributes in kebab-case** (`stroke-width`, not `strokeWidth`). Preact passes camelCase
attribute names through verbatim, and the HTML parser doesn't recognise `strokeWidth` — the stroke
silently renders at the default width. React used to rewrite these; nothing does now.

### Client code has three tiers, and the default is the first

The server owns state and rendering. Before writing any client code ask: *if JavaScript were off,
would this be wrong, or merely slower?* Wrong is server work. The tiers, in order of preference:

1. **Plain form, redirect, flash** — the default for every mutation, no justification needed.
2. **Enhanced form** — same form and controller, answered with a fragment; only when a reload
   would lose context the user is holding, with the reason in a comment on the component.
3. **Presentation over rows already rendered** — show, hide, count, filter; never domain data.

`src/client/boundaries.test.ts` enforces this and fails the suite rather than a review. How the
client layer and the fragment protocol work is in `.claude/rules/`, which loads when
you open the matching files.

### Service tests mock the DB module before importing the service

`src/server/services/*.test.ts` call `mock.module("./database", ...)` and *then* import the
service under test. The imports sit below executable code on purpose — that ordering is what
makes the mock take effect. Don't tidy it.

### The test runner is a script, not `bun test`

`bun run test` runs `src/server/test-utils/run-tests.ts` for the two things `bun test` won't do
itself: apply migrations first, and set `NODE_ENV=test` (Bun picks its `.env` file from it before
any preload runs). Isolation is `bun test --isolate`'s job — fresh globals and module registries
per file, one shared transpile cache — and `--parallel` runs one worker per core, each with its
own database derived from `BUN_TEST_WORKER_ID` (slot 1 keeps the base name, so single-worker runs
and `test:file` use the database they always did). `TEST_WORKERS=1` when a failure needs a
readable, ordered log. Full mechanics: the `verifying-changes` skill.

Module-level state is the hazard isolation doesn't excuse: `rate-limit.ts`'s `requestLog` Map is
shared by every file in a process, so a file exercising a rate-limited route must call
`clearRateLimitLog()` in `beforeEach` or it passes alone and fails after any file that drove the
limiter to 429.

`run-tests.ts` sweeps only the paths in its `TEST_PATHS`, which is `["src", "./.railway/railway.test.ts"]`.
A test outside `src/` never runs in the `bun run test` job unless it is named there. Add opted-in
files by name; a widened glob would drag the smoke test in. `scripts/browser-smoke.test.ts` is
deliberately out — it needs a built bundle and a listening server — and runs in its own CI job
(`Browser smoke tests` in the repository-root `.github/workflows/ci.yml`) through
`bun run test:browser`; `runbooks/CI.md` §1a has it.
A path inside a dot-directory needs the leading `./`: `bun test` reads a bare argument as a name
filter, and a filter never matches there.

### Every test file's database connection comes from `testDatabase()`

Service and controller tests `mock.module` the database module with their own `SQL` instance, so
every test file owns a pool. `new SQL(url)` with no options takes Bun's default max of **10**, and
`--parallel` runs one file per core — ten cores is up to 100 connections against a server whose
`max_connections` is typically 100, with the dev server already holding 10. Past the line Postgres
answers `sorry, too many clients already` (SQLSTATE 53300) to whichever file happened to be
connecting, so the failure names an innocent file and the next run is green. It has been
misdiagnosed as agent contention and as a flaky auth controller.

`testDatabase()` (`src/server/test-utils/database.ts`) is the only way to build one: it caps the
pool at 3 and does the `DATABASE_URL` check. Three, not one — a test holding a reserved connection
(advisory lock, row lock, a `begin()` that also reads outside the transaction) needs two at once,
and a pool of one deadlocks into a hang with no error. `database.test.ts` fails the suite if any
test file calls `new SQL(` directly. Don't fix a connection-exhaustion failure by lowering
`TEST_WORKERS`: that costs parallelism, hides the cause, and the next test file re-adds ten
connections.

### The pool is guarded, and it is the only tag

`db` from `src/server/services/database.ts` is the single tag every query in the codebase uses, and
it is a guarded `Proxy` over the pool — an array or an undeclared plain object bound as a parameter
throws at the call site, in production as much as in tests. It has to be a throw: an array arrives
as `"a,b"` and an object as `"[object Object]"`, both legal SQL with no error at any layer. Write
`inList`, `textArrayLiteral` or `jsonbValue` from `src/server/utils/sql.ts` instead, and
`expectQueryToReject` from `test-utils/helpers.ts` when asserting a query fails — `.rejects` on a
tagged template hangs rather than failing. `src/server/database/driver-safety.test.ts` fails the
suite on the ones the guard can't see. Detail and reasoning: `.claude/rules/database.md`.

### One preload sets the test environment

`bunfig.toml` preloads `src/server/test-utils/test-env.ts`, which pins the whole test environment
(`SESSION_COOKIE_NAME`, `TRUST_PROXY`, `PORT`, `APP_URL`, `SITE_APP_URL`, `CRYPTO_PEPPER`,
`APP_NAME`), and `src/client/test-utils/setup.ts`, which registers
happy-dom globals and then restores Bun's native `Request`/`Response`/`FormData` — but **not**
`fetch`: happy-dom's fetch stays installed and enforces the Same-Origin Policy, so a test that
needs real network must use `Bun.fetch`.

A preload is the only place early enough: imports are hoisted above a file's body, so values
captured at import time (`SESSION_COOKIE_NAME` in `services/sessions.ts`, `CRYPTO_PEPPER` in
`utils/crypto.ts`) are already read before a test's first line runs. `.env.test` carries
`DATABASE_URL` and nothing else — anything else you put there is overridden. A test that needs a
non-default value sets the variable per case, at runtime.

### Sign-in goes through the site, and the CMS has no login of its own

There is no `/login`, no magic link and no email delivery in this app. A signed-out visit to a
guarded page is redirected to `/sign-in`, which sends the browser to the site's Billet app at
`<SITE_APP_URL><CMS_SIGN_IN_PATH>` (see `services/sign-in.ts`). `SITE_APP_URL` is required —
without it the CMS can sign nobody in, and `validateEnv` refuses to boot when it is missing or not
a valid http(s) URL. The site mounts that route from the
plugin (`handleCmsSignIn` in `packages/billet-cms/src/sign-in`); it resolves the site's own signed-in
user, refuses anyone not in `cms_identities`, and mints a single-use handoff token that the CMS's
`/handoff` route spends to start a `cms_session`. The two halves share only the database and the
contract — never a secret and never an API call.

`/handoff` keeps the GET-confirm/POST-spend shape every single-use token needs: a browser prefetch
or a link scanner that followed the URL would otherwise burn the token before the person clicked.
Both the Edit content link and the sign-in route use it.

### Roles live in `cms_identities`, not a CMS account table

The CMS has no account table and no admin or team surface: the user admin dashboard
(`/admin`), organisations and teams, and the `/team` and `/invites` routes were all removed with
the rest of the upstream strip (see `../AGENTS.md`). `cms_identities` is the site's view (the
default exposes the site's admins) and carries `id`, `email` and `role`; a session stores an
identity's `id` and re-reads the view on every request, so a site that removes an account ends the
session at the next request. A guard that needs "is this still a valid identity" re-reads the view
rather than consulting a separate role table.

### The CMS never touches passwords

The CMS has no password field, no password hashing in its own sign-in path and no credential column
on any `cms_` table. Sign-in reads the site's accounts through `cms_identities`, which exposes
`id`, `email` and `role` only, and hands the browser to the site for the login step — so a
password never crosses into the CMS. `hashPassword`/`verifyPassword` remain in `utils/crypto.ts`
for the site's own use; they are deliberately *not* peppered with `CRYPTO_PEPPER`, unlike everything
else in that file — see the comment there.

`readFormValues` (`src/server/utils/form-data.ts`) is an unused upstream helper, kept so a future
port diffs cleanly; nothing in the CMS imports it. It trims values and drops empties, which would
not suit a credential: reading one verbatim would need a reader of its own instead.

### Security headers and CSP are centralised

Every response gets its headers from `secureRoutes` / `handleGuarded` in
`src/server/utils/security-headers.ts`. Controllers set only content-specific headers.

The CSP script allowlist is `'self'` — first-party code only, no inline scripts (the JSON-LD block is a data block CSP doesn't check). There is no
third-party `<script>` any more (the Lottie player and its unpkg allowlist were removed), so
adding an external source is a deliberate decision rather than a follow-up: land the CSP entry, an
SRI `integrity` hash and a `preconnect` in `layouts.tsx` together — otherwise it is silently
blocked in the browser but passes every test.

`X-Robots-Tag: noindex, nofollow` is one of those headers, and it is on **by default**:
`indexingAllowed()` (`services/seo.ts`) is true only when `ALLOW_INDEXING=true`, so an
unconfigured host — a preview, a fork's first deploy, your test run — says `noindex` in the header
and in the meta tag `layouts.tsx` renders. `robots.txt` keeps crawling *allowed* either way and
only drops its `Sitemap:` line: a crawler has to fetch a page to be told `noindex`, so blocking the
fetch would strand the layers that do the work. Every page rendering `noindex` in a test is the
default, not a bug. A test about a
page's *own* `noindex` prop must open the switch first — `withIndexingAllowed` in
`test-utils/helpers.ts` — or it passes on the default and would keep passing after the prop it
exists to protect was deleted. `runbooks/SEO.md` §1b has the rest, including why the variable has
to be set with the deploy rather than after it.

### An uncaught throw in an API controller becomes an *HTML* 500

`handleGuarded` catches everything and answers with `render500()` — the styled HTML error page —
whatever the route was. So a bare `await req.json()` on a malformed body sends an error page to a
JSON client and logs the request as a server fault, for what was the caller's typo.

`src/server/controllers/api/request-guard.ts` is the fix, and every `/api` controller opens with
it: `readJsonBody` (415 on the wrong `Content-Type`, 400 on unparseable or non-object),
`readIdParam`, `readPagination`, and `apiReadLimit` / `apiWriteLimit`. Errors go through
`jsonError` in `utils/response.ts` — one `{ error: { code, message } }` envelope, shared with the
rate limiter, with a stable `code` and a `message` no test should assert on.

API routes use `createApiRouteHandler`, not `createRouteHandler` — same method dispatch, JSON 405.
Both send `Allow`. Use it even for a one-method resource: a bare handler in a Bun routes map
answers *every* method.

### Env is validated at boot and `APP_URL` is load-bearing

`validateEnv()` exits the process on a missing var, then migrations run before `Bun.serve()` — a
failed migration means no server. `src/server/services/database.ts` throws at import time without
`DATABASE_URL`, so anything that imports it (directly or not) needs the env set.

`APP_URL` must include the port. CSRF origin validation compares the request `Origin` against it
exactly, so `http://localhost` vs `http://localhost:3000` rejects every form post with a 403.

### Assets are only fingerprinted in production

`initAssets()` and `getAssetUrl()` no-op unless `NODE_ENV=production`, so asset URLs differ between
dev and prod. In production the files must already exist in `dist/assets` or startup throws.

The un-hashed dev bundle is served by `serveDevBundle` (`src/server/utils/static-files.ts`), not
`serveFile`, and that distinction is load-bearing. `bun build --watch` rewrites `dist/assets/*` in
place, so a reload can read the file mid-write; `serveFile` would stream those zero bytes as a 200
carrying `max-age=3600`, and the stylesheet would stay missing for an hour. `serveDevBundle` reads
the whole file into memory, answers an empty read with a 503 + `Retry-After`, and sets `no-store`
throughout — so a mid-rebuild request costs one reload, never a cached blank.

A bundle that is *absent* rather than empty gets the same 503, not a 404: `handleFallback` checks
the name against `BUNDLE_FILENAMES` (`src/server/services/assets.ts`), so `/assets/main.css` with
no build behind it reads as build state the next `bun run build` fixes, while `/assets/typo.js`
stays a 404. `warnOnMissingDevBundles()` says the same thing at boot, and `bun run dev` builds once
before starting the watchers.

Anything that reads or writes `dist/assets` in a test must call `setAssetsDirForTest()` first.
`assets.test.ts` used to build its fixtures in the real `dist/assets` and `rmSync` the whole
directory in `afterAll` — running that one file (`bun test src/server/services/assets.test.ts`, an
editor's test button) deleted the running dev server's bundles, and every page went unstyled until
someone ran `bun run build`. Every read of the directory goes through `assetsDir()`
(`initAssets`, `handleAssetRequest`, `warnOnMissingDevBundles`, and `handleFallback`) so the
override covers all of them; pass `null` in an `afterEach`/`finally` to restore it. It is
deliberately not an env var — `--outdir ./dist/assets` is fixed in `package.json`, so pointing a
deployment somewhere else would only break boot.

### The upstream release is in `.billet-version`, not `package.json`

`package.json`'s `version` belongs to this fork, not to upstream Billet. `.billet-version` is the
separate, rename-proof record of which Billet release the tree came from: one version line,
everything else comment.

Read it before deciding whether a reported bug is real. A fork reporting something already fixed
upstream is the common case, and without that line the only way to tell is diffing source against a
repo the fork may not have as a remote. With it, `git log <tag>..HEAD -- <path>` settles it. There
is deliberately no script — the file's comment carries the `curl` commands for upstream's tags and
CHANGELOG, and every release documents what a fork must change under **Breaking changes**.

Bump it in the release commit, next to the `package.json` bump and the CHANGELOG entry — which is
its own PR, after the feature PR has merged. `runbooks/RELEASE.md` has the whole process.

### Linting

Biome runs with `recommended` on and `noConsole: error` — use `log` from
`src/server/services/logger.ts` in server code. Test files, `logger.ts`, the
database CLI scripts, and `test-utils/bootstrap.ts` have targeted overrides in
`biome.json`; add an override there rather than sprinkling ignore comments.

### Naming that isn't inferable

App controllers export a plain name (`sitemap`, `media`); API controllers use an `Api` suffix
(`statsApi`) so both can be barrel-exported when they share a resource name.

## Skills

Detail lives in skills so it loads only when it's relevant:

- `adding-a-feature` — wiring a new page or API endpoint through every layer
- `writing-tests` — the testing pattern for each module type
- `verifying-changes` — how to run checks and tests, and what the failures mean

## Runbooks

`runbooks/` holds the operational standards this project is held to — `SECURITY.md`, `PRIVACY.md`,
`ACCESSIBILITY.md`, `SEO.md`, `CI.md`, `RELEASE.md`. Read the relevant one
before changing headers, cookies or metadata, or cutting a release.
