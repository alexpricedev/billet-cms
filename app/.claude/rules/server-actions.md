---
paths:
  - "src/server/controllers/**"
  - "src/server/utils/**"
  - "src/server/templates/**"
  - "src/server/components/**"
---

# Forms, fragments and form actions

> **This is the Billet CMS fork of Billet.** The repo-root `AGENTS.md` and
> `app/CLAUDE.md` list what the strip removed from upstream (todos, teams,
> password auth, the user admin dashboard, the seed script, `scripts/qa-session.ts`)
> and which tables were renamed to `cms_`. Examples below still name upstream
> surfaces — read `users` as the site's `cms_identities` view, `sessions` and
> `user_tokens` as `cms_sessions` and `cms_user_tokens`, and treat the todo
> page, `/admin` and `/team` as gone.

Loaded when you open a controller, template, component or server utility. The always-on rule —
three tiers, plain form by default — is in CLAUDE.md; this is the server half of the machinery.

## Every mutation is a form, and the fetch is an enhancement of it

The todo page's add, toggle and delete are plain `<form method="POST">`s that work without
JavaScript through the redirect-and-flash flow. `server.submit` (`src/client/reactive/request.ts`)
posts the same form with two headers: the form's CSRF token promoted to `X-CSRF-Token`, which
`checkCsrf` reads before the body, and `X-Fragment: 1`. A controller checks `isFragmentRequest(req)`
and answers with `renderFragment(<TodoRow />)` — the same server component the page renders with —
instead of the redirect; the client inserts or swaps the row and calls `bind`. The header names live
in `src/shared/protocol.ts` and `services/csrf.ts` re-exports them; don't spell them anywhere else.

A stale token on a fragment request gets `refreshCsrfToken()`: a 403 carrying a fresh token in the
same header, which `server.submit` writes back into the form and retries once. Only `expired-token`
gets that. A forged or cross-origin token fails hard with no header, exactly as a plain post does —
see `isRecoverableCsrfFailure` for why the distinction is load-bearing.

`server.submit` sends `redirect: "manual"`, so a controller that redirects reads as a failure rather
than a login page handed back as a row; upstream `formAction` answered a fragment request that a
guard refused with a 401 (sent to `/sign-in`) or 403 instead of the redirect. On any failure the
component falls back to `form.submit()`, and the server's flash says what happened. Never return a
full page to a fragment request, and never return a fragment to a plain post.

> **None of the fragment machinery above is used by this fork.** The CMS has no
> enhanced forms: its only page-specific client script is `src/client/cms-form.ts`,
> and every mutation is a full-page POST that redirects. The section is kept for a
> future port; the CMS-side token pattern is the next section.

## POST controllers check CSRF directly; the `formAction` wrapper is upstream-only

> **This fork does not use `formAction`.** The CMS's POST controllers call
> `checkCsrf(req, { method: "POST", path })` and mint GET-side tokens with
> `createCsrfToken(sessionId, "POST", path)` from `services/csrf.ts`; the
> `csrfTokens(...)` helper this section used to describe was removed with the
> upstream strip. `src/server/utils/form-action.ts` and
> `src/server/utils/form-data.ts` (`readFormValues`) are kept as unused upstream
> code so a future port diffs cleanly — nothing in the CMS imports them.

`formAction` (`src/server/utils/form-action.ts`) owned everything around the
decision upstream: the guard (`"session"`, `"user"`, or a function), the CSRF
check with stale-token recovery on both paths, and the
response — redirect-and-flash for a plain post, fragment or bare status for a
fragment request. A handler returns an outcome, not a Response: `{ flash,
fragment, status }` for success, `{ reject, flash }` for a refusal, or a
`Response` as the escape hatch. The CMS's own controllers instead do the guard,
the check and the response by hand — see `controllers/cms/slot.tsx` and
`controllers/cms/pages.tsx` for the shape (`requireAuth`, `checkCsrf` with
`isRecoverableCsrfFailure`, then `render` or `redirect`).
