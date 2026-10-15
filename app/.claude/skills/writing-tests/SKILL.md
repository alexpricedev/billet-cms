---
name: writing-tests
description: Testing patterns for this repo — which layer gets mocked, how service tests reach PostgreSQL, and how client tests get a DOM. Use when adding or changing a *.test.ts / *.test.tsx file, when a new module needs test coverage, or when an existing test fails in a way that looks like a setup problem.
---

# Writing tests

> **This is the Billet CMS fork of Billet.** The repo-root `AGENTS.md` and
> `app/CLAUDE.md` list what the strip removed from upstream (todos, teams,
> password auth, the user admin dashboard, the seed script, `scripts/qa-session.ts`)
> and which tables were renamed to `cms_`. Where a generic example below still
> names a table, read `users` as the site's `cms_identities` view, and
> `sessions` / `user_tokens` as `cms_sessions` / `cms_user_tokens`.

Tests are co-located: `media.test.tsx` sits next to `media.tsx`. Test user-visible behaviour rather
than implementation, and cover both guest and authenticated paths for anything auth-aware.

The mocking boundary is the same everywhere: **mock the service layer, exercise everything above
it for real.** Controllers are tested against real `Response` objects and real rendered HTML, not
against assertions that a render function was called.

Pick the reference for the layer you're working in:

| Layer | Reference |
|---|---|
| `controllers/api/`, `controllers/app/` | `references/controllers.md` |
| `services/`, `middleware/` | `references/services.md` |
| `src/client/**` | `references/client.md` |

`src/server/test-utils/` holds the shared kit: `helpers.ts` (`cleanupTestData`, `seedTestData`,
`randomEmail`), `setup.ts` (`createMockRequest`, `expectJsonResponse`), `factories.ts`, and
`bun-request.ts` for building `BunRequest` values with route params.

Run everything with `bun run test` — see the `verifying-changes` skill for why the raw `bun test`
command misbehaves here.
