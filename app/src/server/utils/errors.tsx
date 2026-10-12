import type { JSX } from "preact";
import { renderToString } from "preact-render-to-string";
import { ErrorPage } from "../templates/error";

// Renders an error template to a bare HTML Response. Callers pass it through
// `finalizeResponse` (compression + security headers) before it leaves the
// server, exactly like every other response.
const renderError = (
  element: JSX.Element,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(`<!DOCTYPE html>${renderToString(element)}`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });

// 404 — the requested resource does not exist. Correct status (never a soft 200),
// with site navigation and a homepage link as the way forward.
export const render404 = (): Response =>
  renderError(
    <ErrorPage
      status={404}
      heading="Page not found"
      message="We couldn't find the page you were looking for. It may have moved, or it may never have existed."
    />,
    404,
  );

// 500 — an unexpected server failure. Deliberately vague: no stack traces,
// framework names, or paths reach the user.
export const render500 = (): Response =>
  renderError(
    <ErrorPage
      status={500}
      heading="Something went wrong"
      message="An unexpected error occurred on our end. Please try again in a moment — if it keeps happening, come back a little later."
    />,
    500,
  );

// 503 — the site is intentionally offline for maintenance. Includes a
// Retry-After header so clients and crawlers know when to return, and drops the
// nav/home affordances since every route is offline.
export const render503 = (retryAfterSeconds: number): Response =>
  renderError(
    <ErrorPage
      status={503}
      heading="We'll be right back"
      message="The site is offline for scheduled maintenance. Please check back shortly."
      showHome={false}
      nav={false}
    />,
    503,
    { "Retry-After": String(retryAfterSeconds) },
  );

// 503 — the CMS can't sign anyone in because it has no site URL to hand them to.
// Distinct from maintenance: the site is up, the CMS just isn't configured, so
// the nav stays and the message points the operator at the missing setting
// without leaking anything a visitor can act on.
export const renderSignInUnavailable = (): Response =>
  renderError(
    <ErrorPage
      status={503}
      heading="Sign-in is unavailable"
      message="This CMS can't send you to the site to sign in right now. If you run the service, set SITE_APP_URL to the site's URL."
    />,
    503,
  );
