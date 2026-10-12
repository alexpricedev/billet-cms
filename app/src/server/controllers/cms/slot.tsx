import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import {
  type BlockTypeRecord,
  type FieldIssue,
  findRemovedFields,
  getBlockTypeByName,
  getLatestRevision,
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
 * Shared by the GET and by the two POST outcomes that render instead of
 * redirect (a validation failure and a conflict), so all three show the same
 * controls around the same content.
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
      content={content}
      baseRevisionId={baseRevisionId}
      removedFieldNames={removed.names}
      removedContent={removed.values}
      errors={extras.errors}
      conflict={extras.conflict ?? null}
      saved={extras.saved}
    />,
  );
};

export const slotForm = {
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/login");

    const slotId = (req.params as { id: string }).id;
    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const blockType = await getBlockTypeByName(slot.blockName);
    if (!blockType) {
      const navCsrfToken = await createCsrfToken(
        ctx.sessionId,
        "POST",
        "/auth/logout",
      );
      return render(
        <SlotUnavailable
          user={ctx.user}
          slot={slot}
          navCsrfToken={navCsrfToken}
        />,
      );
    }

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
    if (!ctx.user || !ctx.sessionId) return redirect("/login");

    const slotId = (req.params as { id: string }).id;
    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/slots/${slotId}`,
    });
    if (!csrf.ok) return csrf.response;

    const slot = await getSlotById(slotId);
    if (!slot) return render404();

    const blockType = await getBlockTypeByName(slot.blockName);
    if (!blockType) return render404();

    const formData = await req.formData();
    const baseRevisionId = nonEmpty(formData.get("base_revision"));
    const submitted = parseJsonObject(formData.get("content"));

    if (!submitted) {
      return renderSlotForm(ctx, slot, blockType, {}, baseRevisionId, {
        errors: [
          {
            path: "(content)",
            message: "The submitted content could not be read.",
          },
        ],
      });
    }

    // Removed fields travel in their own field so the editor can rebuild the
    // rest from its controls; merge them back before validating and saving.
    const removed = parseJsonObject(formData.get("removed_fields")) ?? {};
    const content = { ...removed, ...submitted };

    const result = await saveSlotDraft({
      slotId: slot.id,
      content,
      baseRevisionId,
      actorId: ctx.user.id,
      overwrite: formData.get("overwrite") === "1",
    });

    if (!result.ok && result.reason === "invalid") {
      return renderSlotForm(ctx, slot, blockType, content, baseRevisionId, {
        errors: result.issues,
      });
    }

    if (!result.ok) {
      return renderSlotForm(ctx, slot, blockType, content, baseRevisionId, {
        conflict: result.newer,
      });
    }

    return redirect(`/cms/slots/${slot.id}?saved=1`);
  },
};
