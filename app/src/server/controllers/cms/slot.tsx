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
import type { SessionContext } from "../../services/sessions";
import { SlotForm, SlotUnavailable } from "../../templates/cms/slot-form";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";

// A slot id reaches `getSlotById` straight from the URL. Postgres answers a
// non-UUID with `invalid input syntax for type uuid`, which would surface as a
// 500 for what is really a missing page.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a JSON object out of a form field, or null when it isn't one. */
const parseJsonObject = (
  value: FormDataEntryValue | null,
): Record<string, unknown> | null => {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const nonEmpty = (value: FormDataEntryValue | null): string | null =>
  typeof value === "string" && value !== "" ? value : null;

interface FormExtras {
  errors?: FieldIssue[];
  conflict?: RevisionConflict | null;
  saved?: boolean;
}

/**
 * Render the generated form for a slot.
 *
 * Shared by the GET and by the POST outcomes that render instead of redirect
 * (a validation failure, a conflict, an expired page), so all of them show the
 * same controls around the same content. Every call mints a fresh CSRF token,
 * which is what lets a stale-token re-render be submitted again.
 */
const renderSlotForm = async (
  ctx: SessionContext,
  slot: SlotRecord,
  blockType: BlockTypeRecord,
  content: Record<string, unknown>,
  baseRevisionId: string | null,
  extras: FormExtras = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const removed = findRemovedFields(content, blockType.fields);

  // The hidden `content` field carries only the declared fields. Removed ones
  // are re-attached server-side from the base revision, so a save with
  // JavaScript off — which posts the hidden field unchanged — still validates.
  const declared = new Set(blockType.fields.map((field) => field.name));
  const declaredContent = Object.fromEntries(
    Object.entries(content).filter(([key]) => declared.has(key)),
  );

  const [formCsrfToken, navCsrfToken] = await Promise.all([
    createCsrfToken(sessionId, "POST", `/cms/slots/${slot.id}`),
    createCsrfToken(sessionId, "POST", "/auth/logout"),
  ]);

  return render(
    <SlotForm
      user={ctx.user as NonNullable<SessionContext["user"]>}
      formCsrfToken={formCsrfToken}
      navCsrfToken={navCsrfToken}
      slot={slot}
      blockType={blockType}
      content={declaredContent}
      baseRevisionId={baseRevisionId}
      removedFieldNames={removed.names}
      errors={extras.errors}
      conflict={extras.conflict ?? null}
      saved={extras.saved}
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
    const saved = new URL(req.url).searchParams.get("saved") === "1";

    return renderSlotForm(
      ctx,
      slot,
      blockType,
      latest?.content ?? {},
      latest?.id ?? null,
      { saved },
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
    const submitted = parseJsonObject(formData.get("content"));

    // The page expired while it was open. Re-render what they posted behind a
    // fresh token instead of a 403 that would lose it.
    if (!csrf.ok) {
      return renderSlotForm(
        ctx,
        slot,
        blockType,
        submitted ?? (await baseContent(baseRevisionId, slot)),
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

    if (!submitted) {
      // Nothing readable was posted. Fall back to the revision they loaded
      // rather than an empty form that looks like the content was lost.
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
              message: "The submitted content could not be read.",
            },
          ],
        },
      );
    }

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

    return redirect(`/cms/slots/${slot.id}?saved=1`);
  },
};
