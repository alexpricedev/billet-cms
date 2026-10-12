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
}

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
    return new Response("You do not have access to the CMS", { status: 403 });
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
