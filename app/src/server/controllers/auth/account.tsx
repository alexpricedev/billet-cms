import type { BunRequest } from "bun";
import { getSessionContext } from "../../middleware/auth";
import { createCsrfToken } from "../../services/csrf";
import { Account } from "../../templates/account";
import { redirect, render } from "../../utils/response";

export const account = {
  async index(req: BunRequest): Promise<Response> {
    // One session read, not two: `requireAuth` used to load the context and
    // this handler loaded it again (each read re-checks the identity view and
    // renews the row), so the page paid for the same session twice.
    const ctx = await getSessionContext(req);
    if (!ctx.isAuthenticated || !ctx.user || !ctx.sessionId) {
      return redirect("/sign-in");
    }

    // Sign-out is the only action on the page, so it needs the one token.
    const csrfToken = await createCsrfToken(
      ctx.sessionId,
      "POST",
      "/auth/logout",
    );

    return render(<Account user={ctx.user} csrfToken={csrfToken} />);
  },
};
