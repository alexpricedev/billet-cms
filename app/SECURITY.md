# Security Features

> **Billet CMS fork.** This app has no sign-in of its own and never stores a
> password. A signed-out visit is sent to the site's Billet app, which mints a
> single-use handoff token the CMS spends. This document describes what this
> service actually does — see `../AGENTS.md` and `CLAUDE.md` for the invariants.

## Sign-in

There is no CMS account, no password field and no emailed sign-in link. A
signed-out visit to a guarded page is redirected to `/sign-in`, which sends the
browser to `<SITE_APP_URL><CMS_SIGN_IN_PATH>` — a route the site mounts from the
plugin (`handleCmsSignIn`). That route resolves the site's own signed-in user,
checks them against `cms_identities`, and mints a single-use 60-second handoff
token that the CMS's `/handoff` route spends to start a `cms_session`.

The CMS never inserts into, updates or deletes the site's `users`, and never
reads or writes password data: `cms_identities` exposes `id`, `email` and `role`
only, and the login step itself belongs to the site's own app. There is no
`/signup`, `/login`, `/forgot-password` or `/reset-password`, and no magic-link,
email-delivery or password-reset machinery of any kind.

## CSRF Protection

Billet implements robust Cross-Site Request Forgery (CSRF) protection using the **synchronizer token pattern**.

### Key Features
- **Per-session secrets** with HMAC-SHA256 tokens bound to method + path
- **Origin/Referer validation** and SameSite cookies for defense in depth
- **Rate limiting** on failed attempts (10 per minute per session)
- **Timing-safe comparison** to prevent timing attacks

### Usage

#### 1. Controller Setup
```typescript
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { createCsrfToken } from "../../services/csrf";
import { csrfProtection } from "../../middleware/csrf";

// GET handler - generate token for forms
async index(req: BunRequest): Promise<Response> {
  const ctx = await getSessionContext(req);
  let csrfToken: string | undefined;

  if (ctx.isAuthenticated && ctx.sessionId) {
    csrfToken = await createCsrfToken(ctx.sessionId, "POST", "/cms");
  }

  return render(<MyTemplate csrfToken={csrfToken} user={ctx.user} />);
}

// POST handler - validate token
async create(req: BunRequest): Promise<Response> {
  const authRedirect = await requireAuth(req);
  if (authRedirect) return authRedirect;

  const csrfResponse = await csrfProtection(req, {
    method: "POST",
    path: "/cms",
  });
  if (csrfResponse) return csrfResponse;

  // Process request...
}
```

#### 2. Template with CsrfField Component
```tsx
import { CsrfField } from "../components/csrf-field";

{user ? (
  <form method="POST" action="/cms">
    <CsrfField token={csrfToken} />
    <input type="text" name="data" />
    <button type="submit">Submit</button>
  </form>
) : (
  <p>Please <a href="/sign-in">sign in</a> to access this feature.</p>
)}
```

#### 3. AJAX Requests
```javascript
// Include token in X-CSRF-Token header
const csrfToken = document.querySelector('[name="_csrf"]')?.value;

fetch('/api/stats', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
  },
  body: JSON.stringify({ name: 'Example' }),
});
```

### Protected Methods
CSRF protection applies to: POST, PUT, PATCH, DELETE

### What It Prevents
- ✅ Cross-site form submissions from malicious sites
- ✅ Cross-site AJAX requests without proper tokens
- ✅ Token reuse across sessions, methods, or paths
- ✅ Replay attacks (time-bounded tokens)
- ✅ Timing attacks (constant-time comparison)

## Additional Security

- **Session Management**: HMAC-protected IDs, secure cookies, 30-day expiration.
  A session stores the site user's id and re-reads `cms_identities` on every
  request, so a site that removes an account ends the session at the next
  request. There is no CMS account to provision or reset.
- **Session fixation**: sign-in regenerates the session id rather than reusing
  the one the browser arrived with.
- **Sign-out**: `/auth/logout` deletes the session and clears the cookie.
- **Input Validation**: Type-safe forms, parameterized queries, XSS prevention
- **Environment Security**: Crypto pepper, environment isolation, no secret logging
- **Absolute URLs are built from `APP_URL`**, never from the request — `appUrl`
  in [`utils/app-url.ts`](src/server/utils/app-url.ts). `new URL(req.url).host`
  is the client's `Host` header, so deriving a canonical or a CSRF origin from
  it would let a forged header point the browser somewhere an attacker controls.

## HTTP Headers, CSP & Transport

The defensive HTTP baseline — security headers on every response, an enforcing
Content Security Policy, HSTS, `/.well-known/security.txt`, Subresource
Integrity, and the deploy/DNS steps — lives in
[`runbooks/SECURITY.md`](runbooks/SECURITY.md). Read it before your first deploy:
the `security.txt` contact address needs setting, and TLS/HSTS-preload/CAA/DNSSEC
are host- and registrar-level steps.
