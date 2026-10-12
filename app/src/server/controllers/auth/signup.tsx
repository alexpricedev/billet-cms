import type { BunRequest } from "bun";
import { guestPageContext } from "../../middleware/auth";
import {
  createMagicLink,
  MAGIC_LINK_EXPIRY_MINUTES,
} from "../../services/auth";
import { captchaEnabled, issueChallenge } from "../../services/captcha";
import { consoleEmailProvider, getEmailService } from "../../services/email";
import { log } from "../../services/logger";
import { setSessionCookie } from "../../services/sessions";
import type { SignupState } from "../../templates/signup";
import { Signup } from "../../templates/signup";
import { appUrl } from "../../utils/app-url";
import { csrfTokens } from "../../utils/csrf-tokens";
import { redirect, render } from "../../utils/response";
import { stateHelpers } from "../../utils/state";
import { guardAuthForm, readEmail } from "./form-guard";

const { getFlash, setFlash } = stateHelpers<SignupState>();

/**
 * Sign-up is the same magic-link mechanism as /login, with sign-up wording — the
 * link creates the account on first use. A separate page is worth it because
 * "create an account" and "sign in" are different intentions even when the
 * plumbing is identical.
 */
export const signup = {
  async index(req: BunRequest): Promise<Response> {
    const page = await guestPageContext(req);
    if ("redirect" in page) return page.redirect;

    // See login.index: the token binds to the guest session, so the cookie has
    // to go out with the page that carries it.
    const { ctx } = page;
    if (ctx.requiresSetCookie && ctx.sessionId) {
      setSessionCookie(req, ctx.sessionId);
    }

    const state = getFlash(req);
    const challenge = captchaEnabled() ? issueChallenge() : null;

    return render(
      <Signup
        csrfToken={await csrfTokens(ctx).for("/signup")}
        state={state}
        challenge={challenge}
        showConsoleHint={consoleEmailProvider()}
      />,
    );
  },

  async create(req: BunRequest): Promise<Response> {
    const guard = await guardAuthForm(req);

    if (!guard.ok) {
      if (guard.reason === "rate-limited" || guard.reason === "csrf") {
        return guard.response;
      }

      if (guard.reason === "honeypot") {
        log.warn("signup", "honeypot tripped, dropping submission");
        setFlash(req, { state: "email-sent" });
        return redirect("/signup");
      }

      if (guard.reason === "csrf-expired") {
        setFlash(req, {
          state: "validation-error",
          error: "This page expired while it was open. Please try again.",
          email: readEmail(guard.formData),
        });
        return redirect("/signup");
      }

      setFlash(req, {
        state: "validation-error",
        error: "Verification failed. Please try again.",
      });
      return redirect("/signup");
    }

    const email = readEmail(guard.formData);

    if (!email?.includes("@")) {
      setFlash(req, {
        state: "validation-error",
        error: "Invalid email address",
      });
      return redirect("/signup");
    }

    try {
      const { user, rawToken } = await createMagicLink(email.toLowerCase());

      await getEmailService().sendMagicLink({
        to: { email: user.email },
        magicLinkUrl: appUrl(`/auth/callback?token=${rawToken}`),
        expiryMinutes: MAGIC_LINK_EXPIRY_MINUTES,
      });

      setFlash(req, { state: "email-sent" });
      return redirect("/signup");
    } catch {
      setFlash(req, {
        state: "validation-error",
        error: "Something went wrong. Please try again.",
      });
      return redirect("/signup");
    }
  },
};
