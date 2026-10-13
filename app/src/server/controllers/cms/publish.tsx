import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import {
  buildPreviewUrl,
  createPreviewToken,
  getBlockTypeByName,
  getLatestRevision,
  getRevisionById,
  getSlotById,
  publishSlot,
  restoreSlotRevision,
} from "../../services/content";
import { render404 } from "../../utils/errors";
import { redirect } from "../../utils/response";
import { UUID_PATTERN } from "./params";
import { renderSlotForm } from "./slot";

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
  /**
   * Mint a preview token and open the slot's page on the site with it.
   *
   * A slot has no URL of its own: it is rendered inside one of the site's own
   * pages, so the slot is declared with a `previewPath` (publish writes it to
   * `cms_slots.preview_path`) and the CMS opens that path. The plugin then
   * renders this slot's draft inside the page it already renders.
   */
  async preview(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/slots/${slotId}/preview`,
    });
    if (!csrf.ok) return csrf.response;

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const token = await createPreviewToken({
      subjectType: "slot",
      subjectId: slot.id,
      createdBy: ctx.user.id,
    });

    const url = buildPreviewUrl({
      baseUrl: process.env.SITE_APP_URL,
      path: slot.previewPath,
      rawToken: token.rawToken,
    });
    if (!url) return redirect(`/cms/slots/${slot.id}?preview=unavailable`);

    return redirect(url);
  },

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
      if (result.reason === "invalid") {
        // The draft no longer matches the block's fields. Show it back with the
        // failing fields inline, exactly as a refused save does, rather than a
        // generic notice: the editor can see what to fix and save again.
        const revision = revisionId
          ? await getRevisionById(revisionId)
          : await getLatestRevision("slot", slotId);
        return renderSlotForm(
          ctx,
          slot,
          blockType,
          revision?.content ?? {},
          revision?.id ?? null,
          { errors: result.issues },
        );
      }
      return redirect(`/cms/slots/${slotId}?publish=empty`);
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
