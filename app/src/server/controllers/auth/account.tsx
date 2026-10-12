import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { createCsrfToken } from "../../services/csrf";
import { Account } from "../../templates/account";
import { redirect, render } from "../../utils/response";

export const account = {
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    // Sign-out is the only action on the page, so it needs the one token.
    const csrfToken = await createCsrfToken(
      ctx.sessionId,
      "POST",
      "/auth/logout",
    );

    return render(<Account user={ctx.user} csrfToken={csrfToken} />);
  },
};
