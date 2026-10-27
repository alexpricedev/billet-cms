import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import {
  getBlockTypeByName,
  getSlotById,
  listSlotHistory,
} from "../../services/content";
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

    // The block's name is on the header's muted line, beside the slot's key —
    // the same pair the slot editor shows. A block type a deploy removed is
    // still named, because the history it belongs to is still readable.
    const blockType = await getBlockTypeByName(slot.blockName);

    // `?before=<revision id>` pages back through older revisions. A malformed
    // value is treated as "first page" rather than crashing the UUID cast.
    const params = new URL(req.url).searchParams;
    const beforeParam = params.get("before");
    const before =
      beforeParam && UUID_PATTERN.test(beforeParam) ? beforeParam : null;
    const page = await listSlotHistory(slot, { before });

    const [restoreCsrfToken, navCsrfToken] = await Promise.all([
      createCsrfToken(ctx.sessionId, "POST", `/cms/slots/${slot.id}/restore`),
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
    ]);

    // "Show older" continues from the last revision on this page, so the next
    // page is exactly the revisions below it.
    const oldest = page.revisions[page.revisions.length - 1];
    const olderHref =
      page.hasOlder && oldest
        ? `/cms/slots/${slot.id}/history?before=${oldest.id}`
        : null;

    return render(
      <SlotHistory
        user={ctx.user}
        slot={slot}
        blockType={blockType}
        revisions={page.revisions}
        olderHref={olderHref}
        restoreCsrfToken={restoreCsrfToken}
        navCsrfToken={navCsrfToken}
        notice={historyNotice(params)}
      />,
    );
  },
};
