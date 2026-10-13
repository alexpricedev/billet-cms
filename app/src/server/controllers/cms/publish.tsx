import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import {
  getBlockTypeByName,
  getSlotById,
  publishSlot,
  restoreSlotRevision,
} from "../../services/content";
import { render404 } from "../../utils/errors";
import { redirect } from "../../utils/response";
import { UUID_PATTERN } from "./params";

const nonEmpty = (value: FormDataEntryValue | null): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * Publish and restore, as their own POST endpoints.
 *
 * They are separate routes from the save so a browser refresh repeats a
 * redirect, not the action, and so each carries a CSRF token bound to its own
 * path — a token minted for the form can't be replayed against publish.
 */
export const slotPublish = {
  /** Make a draft the revision the site renders, refusing if a newer one exists. */
  async publish(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/slots/${slotId}/publish`,
    });
    if (!csrf.ok) return csrf.response;

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const blockType = await getBlockTypeByName(slot.blockName);
    if (!blockType || blockType.removedAt) {
      return redirect(`/cms/slots/${slotId}?unavailable=1`);
    }

    // The revision the editor's form rendered. Posting it (rather than letting
    // the service pick the newest) is what stops a publish from putting a
    // colleague's newer draft live without the editor ever seeing it.
    const formData = await req.formData();
    const revisionId = nonEmpty(formData.get("revision"));
    // The id lands in a UUID column when a revision is named, so a malformed
    // one would be a Postgres cast error and surface as a 500. A form that no
    // longer names a real revision is exactly what the stale check reports, so
    // send the editor back to re-check rather than crash.
    if (revisionId && !UUID_PATTERN.test(revisionId)) {
      return redirect(`/cms/slots/${slotId}?publish=stale`);
    }

    const result = await publishSlot({
      slotId,
      slot,
      blockType,
      ...(revisionId ? { revisionId, requireLatest: true } : {}),
    });
    if (!result.ok) {
      if (result.reason === "stale") {
        return redirect(`/cms/slots/${slotId}?publish=stale`);
      }
      return redirect(
        `/cms/slots/${slotId}?publish=${result.reason === "no-draft" ? "empty" : "invalid"}`,
      );
    }

    return redirect(`/cms/slots/${slotId}?published=1`);
  },

  /** Copy a historical revision into a new draft. */
  async restore(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/slots/${slotId}/restore`,
    });
    if (!csrf.ok) return csrf.response;

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const formData = await req.formData();
    const revisionId = nonEmpty(formData.get("revision"));
    if (!revisionId) {
      return redirect(`/cms/slots/${slotId}/history?error=missing`);
    }
    // A revision id goes straight into a UUID column, where a non-UUID is a
    // Postgres cast error and would surface as a 500. Treat a malformed one as
    // an unavailable revision and send the editor back to the history.
    if (!UUID_PATTERN.test(revisionId)) {
      return redirect(`/cms/slots/${slotId}/history?error=not-found`);
    }

    const result = await restoreSlotRevision({
      slotId,
      slot,
      revisionId,
      actorId: ctx.user.id,
    });
    if (!result.ok) {
      return redirect(`/cms/slots/${slotId}/history?error=not-found`);
    }

    return redirect(`/cms/slots/${slotId}?restored=1`);
  },
};
