import type { BunRequest } from "bun";
import type { JSX } from "preact";
import { getSessionContext } from "../../middleware/auth";
import { csrfProtection } from "../../middleware/csrf";
import { rateLimit } from "../../middleware/rate-limit";
import { createCsrfToken } from "../../services/csrf";
import { peekHandoffToken, redeemHandoffToken } from "../../services/handoff";
import {
  getSessionIdFromRequest,
  setSessionCookie,
} from "../../services/sessions";
import { siteOrigin } from "../../services/sign-in";
import {
  HANDOFF_PATH,
  Handoff,
  HandoffExpired,
  HandoffNoAccount,
} from "../../templates/handoff";
import { redirect, render } from "../../utils/response";

// 410, not a redirect: the link is gone for good, and the page says how to get
// another rather than dropping the person on the site's login form.
const gone = (page: JSX.Element): Response => {
  const res = render(page, { "Cache-Control": "no-store" });
  return new Response(res.body, { status: 410, headers: res.headers });
};

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

    if ((await peekHandoffToken(token)) !== "valid") {
      return gone(<HandoffExpired siteUrl={siteOrigin()} />);
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
        // Spent, expired or lost to a second click: say so, with the way to a
        // new link. Someone the site has since removed gets no retry advice.
        return gone(
          result.reason === "no-account" ? (
            <HandoffNoAccount siteUrl={siteOrigin()} />
          ) : (
            <HandoffExpired siteUrl={siteOrigin()} />
          ),
        );
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
