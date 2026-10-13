import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { getSlotById, listSlotHistory } from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { SlotHistory } from "../../templates/cms/slot-history";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { UUID_PATTERN } from "./params";

/** The outcome of a restore that didn't land, shown on the history page. */
const historyNotice = (params: URLSearchParams): string | null => {
  if (params.get("error") === "missing") {
    return "Pick a revision to restore.";
  }
  if (params.get("error") === "not-found") {
    return "That revision is no longer available.";
  }
  return null;
};

/**
 * A slot's history: every revision, newest first, with the published one and the
 * current draft marked. Restoring copies a row into a new draft; it is a POST
 * because it writes, and it carries its own CSRF token rather than the form's.
 */
export const slotHistory = {
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const revisions = await listSlotHistory(slot);
    const [restoreCsrfToken, navCsrfToken] = await Promise.all([
      createCsrfToken(ctx.sessionId, "POST", `/cms/slots/${slot.id}/restore`),
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
    ]);

    return render(
      <SlotHistory
        user={ctx.user}
        slot={slot}
        revisions={revisions}
        restoreCsrfToken={restoreCsrfToken}
        navCsrfToken={navCsrfToken}
        notice={historyNotice(new URL(req.url).searchParams)}
      />,
    );
  },
};
