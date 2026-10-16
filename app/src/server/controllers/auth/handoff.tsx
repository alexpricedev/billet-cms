import type { BunRequest } from "bun";
import { getSessionContext } from "../../middleware/auth";
import { csrfProtection } from "../../middleware/csrf";
import { rateLimit } from "../../middleware/rate-limit";
import { createCsrfToken } from "../../services/csrf";
import { redeemHandoffToken } from "../../services/handoff";
import {
  getSessionIdFromRequest,
  setSessionCookie,
} from "../../services/sessions";
import { HANDOFF_PATH, Handoff } from "../../templates/handoff";
import { redirect, render } from "../../utils/response";

/**
 * Where the site's Edit content link and CMS sign-in both land, in two halves:
 * the GET shows a confirm step and the POST spends the token. The split is the
 * single-use-token rule — a token a prefetch or a scanner could spend by
 * fetching the URL would greet the person with an expired link.
 */
export const handoff = {
  async index(req: BunRequest): Promise<Response> {
    const token = new URL(req.url).searchParams.get("token");

    if (!token) {
      return redirect("/sign-in");
    }

    const ctx = await getSessionContext(req);

    // Already signed in: send them to the content rather than start a second
    // session. The token simply expires unspent.
    if (ctx.isAuthenticated) {
      return redirect("/cms");
    }

    // The form's CSRF token is cut from the session's secret, so that session
    // has to reach the browser along with the page holding the form.
    if (ctx.requiresSetCookie && ctx.sessionId) {
      setSessionCookie(req, ctx.sessionId);
    }

    const csrfToken = ctx.sessionId
      ? await createCsrfToken(ctx.sessionId, "POST", HANDOFF_PATH)
      : null;

    return render(<Handoff token={token} csrfToken={csrfToken} />, {
      "Cache-Control": "no-store",
    });
  },

  async create(req: BunRequest): Promise<Response> {
    // The one signed-out form POST the CMS renders, so it spends the `auth`
    // budget: a script hammering /handoff can't turn token guesses or session
    // churn into load.
    const limited = rateLimit(req, "auth");
    if (limited) return limited;

    const csrfFailure = await csrfProtection(req, {
      method: "POST",
      path: HANDOFF_PATH,
    });
    if (csrfFailure) return csrfFailure;

    const formData = await req.formData();
    const token = formData.get("token");

    if (typeof token !== "string" || !token) {
      return redirect("/sign-in");
    }

    try {
      const result = await redeemHandoffToken(
        token,
        getSessionIdFromRequest(req),
      );

      if (!result.success) {
        // An expired or already-spent token: start a fresh sign-in rather than
        // a dead end. The site mints a new one and comes back to /handoff.
        return redirect("/sign-in");
      }

      setSessionCookie(req, result.sessionId);

      return new Response("", {
        status: 303,
        headers: { Location: "/cms" },
      });
    } catch {
      return redirect("/sign-in");
    }
  },
};
