import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf, isRecoverableCsrfFailure } from "../../middleware/csrf";
import {
  type BlockTypeRecord,
  type FieldIssue,
  findRemovedFields,
  getBlockTypeByName,
  getLatestRevision,
  getRevisionById,
  getSlotById,
  type RevisionConflict,
  type SlotRecord,
  saveSlotDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { listPickerMedia } from "../../services/media";
import type { SessionContext } from "../../services/sessions";
import { SlotForm, SlotUnavailable } from "../../templates/cms/slot-form";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import {
  contentParseMessage,
  nonEmpty,
  parseContent,
  UUID_PATTERN,
} from "./params";
import { previewRedirect } from "./preview";

/**
 * A one-line outcome shown above the form after a save, a publish or a restore.
 *
 * Publish and restore redirect back here with a query flag rather than
 * re-rendering, so a refresh repeats the state instead of the action.
 */
export interface Notice {
  kind: "success" | "warning";
  message: string;
}

export const formNotice = (params: URLSearchParams): Notice | null => {
  if (params.get("saved") === "1") {
    return { kind: "success", message: "Draft saved." };
  }
  if (params.get("published") === "1") {
    return {
      kind: "success",
      message: "Published. The site picks the change up within seconds.",
    };
  }
  if (params.get("restored") === "1") {
    return {
      kind: "success",
      message: "Restored as a new draft. Publish to make it live.",
    };
  }
  if (params.get("publish") === "empty") {
    return { kind: "warning", message: "There is no draft to publish yet." };
  }
  if (params.get("publish") === "stale") {
    return {
      kind: "warning",
      message:
        "Someone saved a newer draft while this page was open, so nothing was published. Reload the page to see and publish the newest version.",
    };
  }
  if (params.get("unavailable") === "1") {
    return {
      kind: "warning",
      message:
        "The block type for this slot is no longer published, so it can't be published.",
    };
  }
  if (params.get("preview") === "failed") {
    return {
      kind: "warning",
      message:
        "Preview couldn't start: the CMS couldn't create a preview link. Try again.",
    };
  }
  return null;
};

interface FormExtras {
  errors?: FieldIssue[];
  conflict?: RevisionConflict | null;
  /** True when the errors came from a refused publish, not a save. */
  refusedPublish?: boolean;
  notice?: Notice | null;
}

/**
 * Render the generated form for a slot.
 *
 * Shared by the GET, by the POST outcomes that render instead of redirect (a
 * validation failure, a conflict, an expired page), and by the publish route
 * when a draft is refused for no longer validating — so all of them show the
 * same controls around the same content and the same inline field errors. Every
 * call mints a fresh CSRF token, which is what lets a stale-token re-render be
 * submitted again.
 */
export const renderSlotForm = async (
  ctx: SessionContext,
  slot: SlotRecord,
  blockType: BlockTypeRecord,
  content: Record<string, unknown>,
  baseRevisionId: string | null,
  extras: FormExtras = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;

  // The newest revision, looked up rather than inferred from what the editor
  // posted: the hidden `base_revision` can point at an older revision (a
  // validation failure re-renders with the posted base), and the form's status
  // and Publish button have to reflect what is actually newest.
  const latest = await getLatestRevision("slot", slot.id);

  // A re-render posts only the declared fields: the hidden `content` field the
  // form renders holds no removed ones, so a save's carried-through fields have
  // to be read back from the revision the editor loaded. Without that, the
  // notice naming them disappears the moment a save fails.
  const base =
    baseRevisionId && baseRevisionId !== latest?.id
      ? await getRevisionById(baseRevisionId)
      : latest;
  const baseContent =
    base && base.targetType === "slot" && base.targetId === slot.id
      ? base.content
      : {};
  const removed = findRemovedFields(
    { ...baseContent, ...content },
    blockType.fields,
  );

  // The hidden `content` field carries only the declared fields. Removed ones
  // are re-attached server-side from the base revision, so a save with
  // JavaScript off — which posts the hidden field unchanged — still validates.
  const declared = new Set(blockType.fields.map((field) => field.name));
  const declaredContent = Object.fromEntries(
    Object.entries(content).filter(([key]) => declared.has(key)),
  );

  const [
    formCsrfToken,
    publishCsrfToken,
    previewCsrfToken,
    navCsrfToken,
    picker,
  ] = await Promise.all([
    createCsrfToken(sessionId, "POST", `/cms/slots/${slot.id}`),
    createCsrfToken(sessionId, "POST", `/cms/slots/${slot.id}/publish`),
    createCsrfToken(sessionId, "POST", `/cms/slots/${slot.id}/preview`),
    createCsrfToken(sessionId, "POST", "/auth/logout"),
    listPickerMedia(declaredContent),
  ]);

  return render(
    <SlotForm
      user={ctx.user as NonNullable<SessionContext["user"]>}
      formCsrfToken={formCsrfToken}
      publishCsrfToken={publishCsrfToken}
      previewCsrfToken={previewCsrfToken}
      navCsrfToken={navCsrfToken}
      slot={slot}
      blockType={blockType}
      content={declaredContent}
      baseRevisionId={baseRevisionId}
      latestRevisionId={latest?.id ?? null}
      publishedRevisionId={slot.publishedRevisionId}
      removedFieldNames={removed.names}
      media={picker.media}
      pickerCapped={picker.capped}
      errors={extras.errors}
      conflict={extras.conflict ?? null}
      refusedPublish={extras.refusedPublish ?? false}
      notice={extras.notice ?? null}
    />,
  );
};

/** A slot whose block type is gone or was removed by a deploy (Q4): flagged, read-only. */
const renderUnavailable = async (
  ctx: SessionContext,
  slot: SlotRecord,
): Promise<Response> => {
  const navCsrfToken = await createCsrfToken(
    ctx.sessionId as string,
    "POST",
    "/auth/logout",
  );
  return render(
    <SlotUnavailable
      user={ctx.user as NonNullable<SessionContext["user"]>}
      slot={slot}
      navCsrfToken={navCsrfToken}
    />,
  );
};

/**
 * The content to show when the POSTed one can't be used: the base revision the
 * editor loaded, so a malformed submission doesn't blank their form.
 */
const baseContent = async (
  baseRevisionId: string | null,
  slot: SlotRecord,
): Promise<Record<string, unknown>> => {
  if (!baseRevisionId) return {};
  const revision = await getRevisionById(baseRevisionId);
  if (!revision) return {};
  if (revision.targetType !== "slot" || revision.targetId !== slot.id) {
    return {};
  }
  return revision.content;
};

export const slotForm = {
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const blockType = await getBlockTypeByName(slot.blockName);
    if (!blockType) return renderUnavailable(ctx, slot);
    if (blockType.removedAt) return renderUnavailable(ctx, slot);

    const latest = await getLatestRevision("slot", slot.id);
    const notice = formNotice(new URL(req.url).searchParams);

    return renderSlotForm(
      ctx,
      slot,
      blockType,
      latest?.content ?? {},
      latest?.id ?? null,
      { notice },
    );
  },

  async create(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const slotId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(slotId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/slots/${slotId}`,
    });
    // A forged or cross-origin token is not authentic — refuse it. A stale but
    // authentic one (an old tab) is handled below, where the work is recovered.
    if (!csrf.ok && !isRecoverableCsrfFailure(csrf)) return csrf.response;

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const blockType = await getBlockTypeByName(slot.blockName);
    if (!blockType) return renderUnavailable(ctx, slot);
    if (blockType.removedAt) return renderUnavailable(ctx, slot);

    const formData = await req.formData();
    const baseRevisionId = nonEmpty(formData.get("base_revision"));
    const parsed = parseContent(formData.get("content"));

    // The page expired while it was open. Re-render what they posted behind a
    // fresh token instead of a 403 that would lose it.
    if (!csrf.ok) {
      return renderSlotForm(
        ctx,
        slot,
        blockType,
        parsed.ok ? parsed.value : await baseContent(baseRevisionId, slot),
        baseRevisionId,
        {
          errors: [
            {
              path: "(form)",
              message:
                "This page expired while it was open. Your content is shown below — save again to keep it.",
            },
          ],
        },
      );
    }

    if (!parsed.ok) {
      // Nothing usable was posted. Fall back to the revision they loaded rather
      // than an empty form that looks like the content was lost, and say
      // whether the body was malformed or simply over the size cap.
      return renderSlotForm(
        ctx,
        slot,
        blockType,
        await baseContent(baseRevisionId, slot),
        baseRevisionId,
        {
          errors: [
            {
              path: "(content)",
              message: contentParseMessage(parsed.reason),
            },
          ],
        },
      );
    }

    const submitted = parsed.value;
    const result = await saveSlotDraft({
      slotId: slot.id,
      slot,
      blockType,
      content: submitted,
      baseRevisionId,
      actorId: ctx.user.id,
    });

    if (!result.ok && result.reason === "invalid") {
      return renderSlotForm(ctx, slot, blockType, submitted, baseRevisionId, {
        errors: result.issues,
      });
    }

    if (!result.ok) {
      // A newer revision exists. Point the form at theirs so a second save is an
      // overwrite of the version the editor has now seen, not a blind write.
      return renderSlotForm(
        ctx,
        slot,
        blockType,
        submitted,
        result.newer.revisionId,
        {
          conflict: result.newer,
        },
      );
    }

    // The editor pressed Preview and was asked to save on the way, so finish
    // what they asked for rather than handing them a form to press it on
    // again. Same tab, not a new one: the save is a navigation, and a
    // `target="_blank"` submitted after one carries no user gesture, so the
    // browser blocks the tab it would open. The banner's "Back to the editor"
    // is the way back, and nothing is lost going there — the draft is saved.
    if (nonEmpty(formData.get("after")) === "preview") {
      return previewRedirect({
        subjectType: "slot",
        subjectId: slot.id,
        path: slot.previewPath,
        createdBy: ctx.user.id,
        // A preview that cannot be minted lands back on the form with the
        // failure said out loud. The draft is already written either way.
        returnTo: `/cms/slots/${slot.id}`,
      });
    }

    return redirect(`/cms/slots/${slot.id}?saved=1`);
  },
};
