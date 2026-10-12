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
import type { LoginState } from "../../templates/login";
import { Login } from "../../templates/login";
import { appUrl } from "../../utils/app-url";
import { csrfTokens } from "../../utils/csrf-tokens";
import { type FlashMessage, getFlashCookie } from "../../utils/flash";
import { redirect, render } from "../../utils/response";
import { stateHelpers } from "../../utils/state";
import { guardAuthForm, readEmail } from "./form-guard";

const { getFlash, setFlash } = stateHelpers<LoginState>();

/**
 * Mint a magic link for `email` and send it, off the request path.
 *
 * Sign-in is invite-only: an unknown address mints nothing. The lookup, the
 * token insert and the email send all happen here, detached from the response,
 * because awaiting them would make a known address measurably slower to answer
 * than an unknown one — the email provider alone is an outbound HTTP call — and
 * the delay alone would be an account-enumeration oracle. Nothing is written to
 * the site's `users` table either way.
 */
const sendMagicLinkInBackground = async (email: string): Promise<void> => {
  try {
    const link = await createMagicLink(email);
    if (!link) return;

    try {
      await getEmailService().sendMagicLink({
        to: { email: link.user.email },
        magicLinkUrl: appUrl(`/auth/callback?token=${link.rawToken}`),
        expiryMinutes: MAGIC_LINK_EXPIRY_MINUTES,
      });
    } catch {
      // A send failure is not the visitor's problem, and surfacing it would
      // only tell them the address has an account. Log it for the operator.
      log.error("login", "Could not send the magic link email");
    }
  } catch {
    log.error("login", "Could not create the magic link");
  }
};

// The most recent detached task. The response deliberately does not wait for
// it, so this is the only handle a test has on the work; production never reads
// it.
let inFlightMagicLink: Promise<void> = Promise.resolve();

/** Wait for the magic link the last POST is still minting and sending. */
export const whenMagicLinkSettled = (): Promise<void> => inFlightMagicLink;

export const login = {
  async index(req: BunRequest): Promise<Response> {
    const page = await guestPageContext(req);
    if ("redirect" in page) return page.redirect;

    // The form posts a CSRF token, so the guest session it binds to has to
    // reach the browser — minting one and dropping the cookie would render a
    // token nothing could verify.
    const { ctx } = page;
    if (ctx.requiresSetCookie && ctx.sessionId) {
      setSessionCookie(req, ctx.sessionId);
    }

    const state = getFlash(req);
    const challenge = captchaEnabled() ? issueChallenge() : null;

    // A flow that finishes by sending someone here to sign in leaves its line
    // on the "message" key. Read here as well as on the homepage, or the cookie
    // survives unread and surfaces on whichever page happens to read it next.
    const message = getFlashCookie<Partial<FlashMessage>>(req, "message");

    // /auth/callback and the other single-use-link dead ends send people here
    // with ?error=. Flash wins when both are present — it belongs to something
    // that just happened on this page. Capped and rendered as text, never as
    // markup, so the query string can't put anything but words on the page.
    const queryError = new URL(req.url).searchParams.get("error");
    const resolved: LoginState =
      state.state || !queryError
        ? state
        : { state: "validation-error", error: queryError.slice(0, 200) };

    return render(
      <Login
        csrfToken={await csrfTokens(ctx).for("/login")}
        state={resolved}
        challenge={challenge}
        message={message.text ? (message as FlashMessage) : undefined}
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
        log.warn("login", "honeypot tripped, dropping submission");
        setFlash(req, { state: "email-sent" });
        return redirect("/login");
      }

      // A stale token is an old tab, not an attack. The address survives so
      // the retry costs a click; the redirect lands on a page that mints a
      // fresh token.
      if (guard.reason === "csrf-expired") {
        setFlash(req, {
          state: "validation-error",
          error: "This page expired while it was open. Please try again.",
          email: readEmail(guard.formData),
        });
        return redirect("/login");
      }

      setFlash(req, {
        state: "validation-error",
        error: "Verification failed. Please try again.",
      });
      return redirect("/login");
    }

    const email = readEmail(guard.formData);

    if (!email?.includes("@")) {
      setFlash(req, {
        state: "validation-error",
        error: "Invalid email address",
      });
      return redirect("/login");
    }

    // Detached: the response is identical and immediate for a known and an
    // unknown address, so how long it takes can't be read as an oracle.
    inFlightMagicLink = sendMagicLinkInBackground(email.toLowerCase());

    setFlash(req, { state: "email-sent" });
    return redirect("/login");
  },
};
