import type { BunRequest } from "bun";
import { getSessionContext } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import { createCsrfToken } from "../../services/csrf";
import { isTheme, setTheme } from "../../services/preferences";
import { Account } from "../../templates/account";
import { redirect, render } from "../../utils/response";

/** Where a theme save lands, and what the account page says when it does. */
const THEME_SAVED = "/account?theme=saved";
const THEME_INVALID = "/account?theme=invalid";

export const account = {
  async index(req: BunRequest): Promise<Response> {
    // One session read, not two: `requireAuth` used to load the context and
    // this handler loaded it again (each read re-checks the identity view and
    // renews the row), so the page paid for the same session twice.
    const ctx = await getSessionContext(req);
    if (!ctx.isAuthenticated || !ctx.user || !ctx.sessionId) {
      return redirect("/sign-in");
    }

    // The page has two forms, so it needs a token for each: the nav's sign-out
    // and the Theme card's save.
    const [csrfToken, themeCsrfToken] = await Promise.all([
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
      createCsrfToken(ctx.sessionId, "POST", "/account/theme"),
    ]);

    // The theme form redirects back here; the flag says how it went.
    const saved = new URL(req.url).searchParams.get("theme");
    const notice =
      saved === "saved"
        ? { type: "success" as const, message: "Theme saved." }
        : saved === "invalid"
          ? {
              type: "warning" as const,
              message: "Choose Light, Dark or System.",
            }
          : null;

    return render(
      <Account
        user={ctx.user}
        csrfToken={csrfToken}
        themeCsrfToken={themeCsrfToken}
        notice={notice}
      />,
    );
  },

  /**
   * Save the editor's theme.
   *
   * A redirect either way, so a refresh repeats the page rather than the
   * write. `services/preferences` refuses an unknown value before it touches
   * the database, but the controller checks it too: a bad post is a form
   * mistake to explain, not a 500.
   */
  async saveTheme(req: BunRequest): Promise<Response> {
    const ctx = await getSessionContext(req);
    if (!ctx.isAuthenticated || !ctx.user || !ctx.sessionId) {
      return redirect("/sign-in");
    }

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: "/account/theme",
    });
    if (!csrf.ok) return csrf.response;

    const submitted = (await req.formData()).get("theme");
    const saved = isTheme(submitted)
      ? await setTheme(ctx.user.id, submitted)
      : null;

    return redirect(saved === null ? THEME_INVALID : THEME_SAVED);
  },
};
