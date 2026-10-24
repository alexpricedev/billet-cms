/**
 * The site's half of CMS sign-in.
 *
 * The CMS has no accounts and no sign-in of its own. A signed-out visit to the
 * CMS is redirected to `<SITE_APP_URL>${CMS_SIGN_IN_PATH}` — a route the site
 * mounts from `handleCmsSignIn` — and this handler does the rest:
 *
 * 1. If nobody is signed in on the site, send them to the site's own login
 *    (password or magic link, whichever the site runs) with a `next` back here.
 * 2. Once someone is signed in, check they are a `cms_identities` row. Anyone
 *    else is refused.
 * 3. Mint a single-use, short-lived handoff token — the same token the Edit
 *    content link uses — and send the browser to the CMS, which spends it and
 *    starts a `cms_session`.
 *
 * The site resolves its own user through the `getUserId` callback: the plugin
 * deliberately knows nothing about the site's sessions or session cookie, only
 * about the shared database. The token is the only thing that travels between
 * the two services, so there is no shared secret and no API call from the CMS.
 */
import type { SQL } from "bun";
import { CMS_SIGN_IN_PATH } from "../contract";
import { createEditContentLink, isCmsIdentity } from "../handoff";

/** The site's own login path (Billet's default), used when nobody is signed in. */
export const SITE_LOGIN_PATH = "/login";

export interface CmsSignInOptions {
  /** The shared pool, for the identity check and the handoff token. */
  sql: SQL;
  /**
   * Resolve the id of the site user making the request, or `null` when nobody
   * is signed in. The site wires this to its own session lookup.
   */
  getUserId: (req: Request) => Promise<string | null> | string | null;
  /**
   * The CMS origin. Defaults to `process.env.CMS_URL`; when neither is set the
   * route answers 503, because there is nothing to sign in to.
   */
  cmsUrl?: string;
  /** The site's own login path. Defaults to `/login`. */
  loginPath?: string;
  /**
   * The path this handler is mounted at, used to build the `next` a signed-out
   * visitor returns to. Defaults to `CMS_SIGN_IN_PATH`.
   */
  path?: string;
  /**
   * Render the page a signed-in non-editor sees instead of the default one.
   * The status is always forced to 403; a hook that throws falls back to the
   * default page.
   */
  renderRefusal?: (ctx: {
    req: Request;
    homeUrl: string;
  }) => Response | Promise<Response>;
}

const REFUSAL_MESSAGE = "You do not have access to the CMS";

/** The default refusal: the same words, who to ask, and a way back to the site. */
export const renderCmsRefusal = (homeUrl = "/"): Response => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${REFUSAL_MESSAGE}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;font:16px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fafafa}
main{max-width:28rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .75rem}
p{margin:0 0 1.5rem}
a{display:inline-block;padding:.625rem 1rem;border-radius:.375rem;background:#1a1a1a;color:#fff;text-decoration:none}
a:focus-visible{outline:2px solid #1a1a1a;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>${REFUSAL_MESSAGE}</h1>
<p>You are signed in to the site, but your account is not set up to edit content. Ask a site administrator to give you access.</p>
<a href="${homeUrl}">Back to the site</a>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
};

const refuse = async (
  req: Request,
  options: CmsSignInOptions,
): Promise<Response> => {
  if (options.renderRefusal) {
    try {
      const custom = await options.renderRefusal({ req, homeUrl: "/" });
      return new Response(custom.body, {
        status: 403,
        headers: custom.headers,
      });
    } catch {
      // Fall through to the default page.
    }
  }
  return renderCmsRefusal();
};

const redirect = (location: string): Response =>
  new Response("", { status: 303, headers: { Location: location } });

/**
 * The plugin's CMS sign-in route. Mount it at `CMS_SIGN_IN_PATH` on the site.
 *
 * The handler never throws: a database the CMS tables aren't in yet, or a site
 * that hasn't set `CMS_URL`, answers a plain error rather than a stack trace,
 * because this route sits on the site's public surface.
 */
export const handleCmsSignIn = async (
  req: Request,
  options: CmsSignInOptions,
): Promise<Response> => {
  const cmsUrl = (options.cmsUrl ?? process.env.CMS_URL ?? "").trim();
  const path = options.path ?? CMS_SIGN_IN_PATH;
  const loginPath = options.loginPath ?? SITE_LOGIN_PATH;

  let userId: string | null;
  try {
    userId = await options.getUserId(req);
  } catch {
    userId = null;
  }

  // Nobody signed in on the site yet: send them through the site's own login
  // and back here. The `next` keeps only the path and query, never the origin,
  // so the return can't be pointed at another host.
  if (!userId) {
    const requestUrl = new URL(req.url);
    const next = `${path}${requestUrl.search}`;
    return redirect(`${loginPath}?next=${encodeURIComponent(next)}`);
  }

  const base = cmsUrl.replace(/\/+$/, "");
  if (!base) {
    return new Response("CMS sign-in is not configured (CMS_URL is unset)", {
      status: 503,
    });
  }

  let identity: boolean;
  try {
    identity = await isCmsIdentity(options.sql, userId);
  } catch {
    return new Response("CMS sign-in is unavailable", { status: 503 });
  }

  // A site user who isn't in the view: a signed-in non-admin, or an account the
  // site's own view keeps out. Refused with a 403, and no token is written.
  if (!identity) {
    return refuse(req, options);
  }

  const link = await createEditContentLink(options.sql, {
    userId,
    cmsUrl: base,
  });
  if (!link) {
    return new Response("CMS sign-in is unavailable", { status: 503 });
  }

  return redirect(link);
};
