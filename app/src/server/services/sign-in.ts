import { CMS_SIGN_IN_PATH } from "@alexpricedev/billet-cms/contract";

/**
 * The site's CMS sign-in route, or `null` when the CMS isn't pointed at a site.
 *
 * The CMS has no sign-in of its own: `SITE_APP_URL` names the site's Billet app
 * and the plugin mounts the route at `CMS_SIGN_IN_PATH` on it. Both come from
 * the contract, so neither side needs to know the other's code. A value that
 * isn't a URL (a typo, a bare host) is treated as unset rather than throwing on
 * every signed-out request.
 */
export const siteSignInUrl = (): string | null => {
  const configured = process.env.SITE_APP_URL?.trim();
  if (!configured) return null;

  try {
    return new URL(CMS_SIGN_IN_PATH, new URL(configured).origin).href;
  } catch {
    return null;
  }
};
