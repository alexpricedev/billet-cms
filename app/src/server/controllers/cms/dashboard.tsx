import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import {
  groupSlotsByPage,
  listPageTypes,
  listSlots,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { Dashboard } from "../../templates/cms/dashboard";
import { redirect, render } from "../../utils/response";

export const dashboard = {
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/login");

    const [slots, pageTypes] = await Promise.all([
      listSlots(),
      listPageTypes(),
    ]);

    const navCsrfToken = await createCsrfToken(
      ctx.sessionId,
      "POST",
      "/auth/logout",
    );

    return render(
      <Dashboard
        user={ctx.user}
        navCsrfToken={navCsrfToken}
        groups={groupSlotsByPage(slots)}
        pageTypes={pageTypes}
      />,
    );
  },
};
