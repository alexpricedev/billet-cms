# Security Runbook

Billet ships a defensive HTTP baseline: a single set of security headers on
**every** response, an enforcing Content Security Policy, HSTS in production,
and a `/.well-known/security.txt`. Cookies and CSRF are covered separately in
the root [`SECURITY.md`](../SECURITY.md). The CMS loads no third-party script:
every `<script>` it renders is first-party, so `script-src` allows `'self'` and
nothing else but the inline JSON-LD allowance below.

This runbook covers what's applied automatically, the one required config step,
how to extend each piece, the deploy- and DNS-layer steps a host can't do for
you, and how to verify it all in production.

Everything except the DNS/transport items is server-side and needs no client JS.

## 1. What's applied automatically

Every response — HTML pages, JSON APIs, static files, redirects, and error
pages — passes through one checkpoint and leaves with the same security headers.
The single source of truth is
[`src/server/utils/security-headers.ts`](../src/server/utils/security-headers.ts),
wired in [`src/server/main.ts`](../src/server/main.ts) two ways:

- `secureRoutes({...})` wraps every declared route handler.
- `withSecurityHeaders(await handleFallback(req))` wraps the static/asset/404 path.

`withSecurityHeaders` only fills in headers a response hasn't already set, so a
route can still override any single header (e.g. a relaxed CSP for one page).

| Header | Value | Notes |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Stops content-type guessing |
| `X-Frame-Options` | `DENY` | Legacy clickjacking defence (CSP `frame-ancestors` is the modern one) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits URL leakage to other sites |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates our browsing context |
| `Permissions-Policy` | deny-all baseline, `fullscreen=(self)` | Turns off camera, mic, geolocation, USB, payment, etc. |
| `X-Robots-Tag` | `noindex, nofollow` | **Only while `ALLOW_INDEXING` is unset** — see [SEO.md §1b](SEO.md). A route that sets its own is left alone |
| `Content-Security-Policy` | see §3 | Source allowlist + clickjacking + https upgrade |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | **Production only** (see §4) |

HSTS is intentionally withheld outside production (`NODE_ENV !== "production"`)
so local development over plain HTTP doesn't pin `localhost` to HTTPS.

One route sets an extra header of its own: **logout**
([`controllers/auth/logout.tsx`](../src/server/controllers/auth/logout.tsx))
sends `Clear-Site-Data: "cookies", "storage"` so the browser wipes cookies and
client storage on sign-out — defence in depth beyond deleting the session cookie.

## 2. Set the security.txt contact (required before launch)

[RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) `security.txt` tells
researchers how to report a vulnerability. Billet serves it dynamically at
`/.well-known/security.txt` from
[`src/server/services/security-txt.ts`](../src/server/services/security-txt.ts)
(controller: [`controllers/app/security-txt.ts`](../src/server/controllers/app/security-txt.ts),
route in [`routes/app.tsx`](../src/server/routes/app.tsx)).

- **`Contact:`** comes from the **`SECURITY_CONTACT`** env var (see
  [`.env.example`](../.env.example)). A bare email is wrapped in `mailto:`; a
  fully-qualified `mailto:` / `https:` / `tel:` URI is used as-is:

  ```bash
  SECURITY_CONTACT=security@yourdomain.com          # → Contact: mailto:security@yourdomain.com
  SECURITY_CONTACT=https://yourdomain.com/security  # → Contact: https://yourdomain.com/security
  ```

  With no env set it falls back to `mailto:security@<the canonical site host>` —
  a placeholder. Set a **monitored** address before you launch.
- **`Expires:`** is computed as one year from process start, so it never lapses;
  it refreshes on every deploy. No action needed.
- **`Canonical:`** is derived from `siteUrl()` in
  [`services/seo.ts`](../src/server/services/seo.ts), which follows `APP_URL`'s
  origin (see [SEO.md](SEO.md) §1). If `APP_URL` is correct, this is correct —
  there is nothing separate to set.

## 3. Content Security Policy

The policy is enforcing and host-allowlist based. Current directives:

```
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none';
img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline';
connect-src 'self'; upgrade-insecure-requests
```

`img-src` gains the media bucket's origin (`MEDIA_PUBLIC_BASE_URL`) when one is
configured, so every thumbnail and focal preview loads; without it the picture
is blocked by the CMS's own policy. The origin is accepted only when it is
http(s) (`utils/http-origin.ts`), the same rule the preview site origin uses.

`upgrade-insecure-requests` ships in production only, like HSTS: WebKit (unlike
Chrome) applies the upgrade to `http://localhost` subresources too, which strips
every asset off the page in local dev and under the browser smoke tests.

What it buys today: no other site can frame our pages (`frame-ancestors 'none'`),
no plugins (`object-src 'none'`), no `<base>` injection (`base-uri 'none'`), any
stray `http://` subresource is auto-upgraded to HTTPS, and code/styles/images may
only load from us.

**Adding a new external source.** If you pull a script, style, image, font, or
API from a new origin, add that origin to the matching directive in
`security-headers.ts`:

- external `<script src>` → `script-src` (plus an SRI `integrity` hash: see §4)
- external stylesheet or `@font-face` host → `style-src` / `font-src`
- `<img>` from a CDN → `img-src`
- `fetch()`/XHR/WebSocket to an API → `connect-src`

Forget one and the browser blocks the resource with a `Refused to load…` console
error. Test in a real browser after any change (see §6).

**The `'unsafe-inline'` tradeoff.** `script-src` includes `'unsafe-inline'`
because the page ships inline JSON-LD in
[`layouts.tsx`](../src/server/components/layouts.tsx). That weakens CSP's XSS
protection. The hardening path (a follow-up, not done here) is nonce +
`'strict-dynamic'`: generate a per-request nonce, stamp it on every inline and
first-party `<script>`, add `'nonce-…' 'strict-dynamic'` to `script-src`, and
drop `'unsafe-inline'`. Every script is first-party now, so there is no CDN
script left to allow first.

**No `'unsafe-eval'`, by design.** The client's reactive layer
(`src/client/reactive/`) binds state to markup through `data-*` attributes that
carry *names* of a component's signals and actions, never expressions, so
nothing on the page evaluates a string. Frameworks that put expressions in
attributes (Alpine, petite-vue, in-DOM Vue) need `'unsafe-eval'`; adding one
means widening this policy.

**The signed-out form is CSRF-checked too.** `/handoff` renders a confirm form
and validates it with `csrfProtection`
([`middleware/csrf.ts`](../src/server/middleware/csrf.ts)). `csrfProtection` clones
the request to read the token, so a controller that reads the form first 403s
every request — it runs before the body parse, not after.

Not having a session is no reason to skip it: without a check a cross-site post
could spend whatever single-use token the form carries. So the `GET` sets the
guest session cookie and mints the token against it — minting one without sending
the cookie renders a token nothing can verify. On a stale CSRF token `/handoff`
answers a plain 403, so the visitor starts again from `/sign-in`.

**Enhanced form posts and CSRF.** `server.submit` (`src/client/reactive/request.ts`)
posts a form with its CSRF token promoted to the `X-CSRF-Token` header, which
`checkCsrf` reads before the body, plus `X-Fragment: 1`. Origin validation
applies to those posts exactly as to plain ones. A token that is stale but
verifies against the session secret is answered with a 403 carrying a fresh
token in the same header, and the client retries once; a forged, missing or
cross-origin token gets no header — `isRecoverableCsrfFailure` is the gate, and
widening it would turn the app into a token vending machine for
attacker-initiated posts. The header names live in `src/shared/protocol.ts`.

## 4. Subresource Integrity (third-party scripts)

The CMS loads **no** third-party script: the Lottie player that used to come
from unpkg — and the `script-src https://unpkg.com` entry and `preconnect` that
existed only for it — is gone. Everything the page runs is first-party, so there
is nothing for SRI to pin today.

If you ever add a third-party `<script>`, pin it on an exact version and add an
`integrity` hash, or a compromised CDN could swap the file:

```html
<script src="https://cdn.example/lib@1.2.3/lib.min.js"
  integrity="sha384-…" crossorigin="anonymous"></script>
```

Recompute the hash for a new version:

```bash
curl -sL "https://cdn.example/lib@<NEW>/lib.min.js" \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

**SRI requires an exact version** — never point `integrity` at a floating range
like `@1`. Add the origin to `script-src` (§3) and, if it is a cross-origin
fetch, a `preconnect` in `layouts.tsx` at the same time.

## 5. Deploy & transport layer (host, not code)

- **HTTPS / TLS.** Provided by the platform. Railway terminates TLS and redirects
  plain HTTP to HTTPS at the edge, so there is no in-app redirect. If you deploy
  elsewhere, confirm the edge does the HTTP→HTTPS redirect.
- **HSTS preload.** The header already advertises `preload`. To get baked into
  browsers, submit the apex domain at [hstspreload.org](https://hstspreload.org)
  **after** confirming every subdomain is HTTPS-only — preload is hard to undo.
- **`TRUST_PROXY=true` behind a reverse proxy.** The rate limiter keys requests by
  client address (`src/server/middleware/client-ip.ts`). Behind Railway (or any
  single proxy that rewrites/appends `x-forwarded-for` itself) set `TRUST_PROXY=true`
  so it reads the last header entry — the hop the proxy added; otherwise every
  visitor shares the proxy's socket address and one busy user 429s everyone.
  Never set it on a deployment reached directly: the header is client-controlled
  there, and trusting it lets an attacker walk past the rate limit with a
  fresh value per request.

## 6. Verify in production

```bash
# Headers present on a normal page
curl -sI https://yourdomain.com/ | grep -iE \
  'content-security-policy|strict-transport|x-content-type|permissions-policy'

# security.txt serves as text/plain with a real Contact + future Expires
curl -s https://yourdomain.com/.well-known/security.txt

# No X-Robots-Tag on a host that is meant to be indexed (see SEO.md §1b).
# `noindex, nofollow` here means ALLOW_INDEXING is unset on this host.
curl -sI https://yourdomain.com/ | grep -i x-robots-tag
```

- **In a browser:** load the site, open the console, confirm no `Refused to
  load…` / CSP violations and that the client bundle mounts on a page that uses
  one (a signed-in CMS page such as `/cms`).
- **Scanners:** [securityheaders.com](https://securityheaders.com),
  [Mozilla Observatory](https://observatory.mozilla.org), and Google's
  [CSP Evaluator](https://csp-evaluator.withgoogle.com) for policy strength.

Note: Chrome logs harmless `Unrecognized feature` warnings for a few
`Permissions-Policy` tokens it hasn't implemented (e.g. `battery`, `web-share`).
They don't affect security; trim those tokens in `security-headers.ts` if you
want a spotless console.

## 7. DNS layer (registrar, not code)

- **CAA records (recommended).** Restrict which certificate authorities may issue
  certs for your domain. Confirm your platform's CA first — a wrong CAA blocks
  renewals. Railway uses Let's Encrypt:

  ```
  yourdomain.com.  CAA  0 issue "letsencrypt.org"
  ```

- **DNSSEC (optional).** Enable at your registrar to cryptographically sign DNS
  records. One-click at most registrars; verify with
  [dnssec-analyzer.verisignlabs.com](https://dnssec-analyzer.verisignlabs.com).

## 8. Deliberately not implemented (yet)

- **Breached-password checks** — not applicable: the CMS stores no password.
  The site's own app owns authentication, and it is the place to screen new
  passwords against a breach corpus if it keeps a credential.
- **Multi-factor authentication** — no TOTP, WebAuthn or emailed second factor.
  The CMS has no credential of its own, so any second factor belongs to the
  site's sign-in, not here.
- **Password expiry / reuse history** — not implemented, and not recommended.
  Forced rotation drives predictable mutations; reuse history means retaining old
  hashes indefinitely.
- **Reporting API (`Reporting-Endpoints` + CSP `report-to`)** — needs a collector
  endpoint to receive violation reports. Add one to observe CSP breakage in the
  wild before tightening the policy.
- **COEP / CORP** — `Cross-Origin-Embedder-Policy` would break cross-origin
  embeds the site chooses to make, and a strict
  `Cross-Origin-Resource-Policy` would block social scrapers from fetching the OG
  image. Only `Cross-Origin-Opener-Policy` is set. Revisit COEP if you ever need
  cross-origin isolation (e.g. `SharedArrayBuffer`).
- **Trusted Types** (`require-trusted-types-for 'script'`) — pairs naturally with
  the nonce-based CSP upgrade in §3.
- **Digest Fields (`Content-Digest`)** — transit-integrity hashes, optional and
  niche for a site behind HTTPS.
