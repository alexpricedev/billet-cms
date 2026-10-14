/**
 * Absolute URLs for the app's own origin, and the origin canonicals, OG tags,
 * the sitemap, preview links and the CSRF check are built from.
 *
 * Built from `APP_URL`, never from the request. `new URL(req.url).host` is the
 * client's `Host` header: a forged one would put an attacker's domain into a
 * real, live link and send a crawler or a reader to it. `APP_URL` is required
 * and validated at boot (`utils/env.ts`) and is the same origin CSRF checks
 * against (`services/csrf.ts`), so the URL and the origin check can't disagree.
 */

/**
 * The app's own origin, scheme through port, with any path dropped. Read from
 * `process.env` on every call rather than captured at import, so a value set
 * after this module loads still counts. `siteUrl()` in `services/seo.ts` falls
 * back to this, which is what keeps the canonical domain and the CSRF origin
 * the same by default.
 */
export const appOrigin = (): string =>
  new URL(process.env.APP_URL as string).origin;

export const appUrl = (path: string): string => `${appOrigin()}${path}`;
