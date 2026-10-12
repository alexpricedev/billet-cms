import type { BunRequest } from "bun";
import { getSessionContext } from "../../middleware/auth";
import { siteSignInUrl } from "../../services/sign-in";
import { renderSignInUnavailable } from "../../utils/errors";
import { redirect } from "../../utils/response";

/**
 * The CMS's signed-out entry point: send the browser to the site's sign-in
 * route, which mints a single-use handoff token and comes back to `/handoff`.
 *
 * It exists so every signed-out link in the CMS has one stable target (`/sign-in`)
 * and the "no site configured" case has one place to answer, rather than each
 * caller reading `SITE_APP_URL` itself.
 */
export const signIn = {
  async index(req: BunRequest): Promise<Response> {
    const ctx = await getSessionContext(req);

    // Already signed in: nothing to do but show them the content.
    if (ctx.isAuthenticated) return redirect("/cms");

    const url = siteSignInUrl();
    if (!url) return renderSignInUnavailable();

    return redirect(url);
  },
};
