/**
 * The validated write layer.
 *
 * Every save the CMS makes goes through a function here — the forms call them
 * now, and the MCP server in a later phase will be a thin wrapper over the same
 * functions. Two rules hold for all of them:
 *
 * 1. **Validate before writing.** Content is checked against the JSON Schema
 *    the site published, rebuilt as a Zod schema, so a stored revision is one
 *    the site will accept when it reads it back.
 * 2. **Never write over someone else's work silently.** A save names the
 *    revision it was based on; if a newer one exists the caller gets a conflict
 *    to show the editor, not a row.
 */
import type { ValidationIssue } from "@alexpricedev/billet-cms/schema";
import { validateContent } from "@alexpricedev/billet-cms/schema";
import { findUserById } from "../auth";
import { getBlockTypeByName } from "./definitions";
import {
  createRevision,
  getLatestRevision,
  type RevisionRecord,
} from "./revisions";
import { getSlotById } from "./slots";

export interface FieldIssue {
  /** Dotted path to the field, e.g. `gallery.0.mediaId`. */
  path: string;
  message: string;
}

/** Who wrote the revision that got there first, for the conflict warning. */
export interface RevisionConflict {
  revisionId: string;
  authorEmail: string | null;
  createdAt: Date;
}

export type SaveDraftResult =
  | { ok: true; revision: RevisionRecord }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
  | { ok: false; reason: "conflict"; newer: RevisionConflict };

export interface SaveSlotDraftInput {
  slotId: string;
  content: Record<string, unknown>;
  /** The revision the editor loaded; null when there was none. */
  baseRevisionId: string | null;
  /** The identity saving, for `created_by`. */
  actorId: string | null;
  /** Set once the editor has seen the conflict warning and chosen to continue. */
  overwrite?: boolean;
}

const formatIssues = (issues: ValidationIssue[]): FieldIssue[] =>
  issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(content)",
    message: issue.message,
  }));

const describeConflict = async (
  revision: RevisionRecord,
): Promise<RevisionConflict> => {
  const author = revision.createdBy
    ? await findUserById(revision.createdBy)
    : null;

  return {
    revisionId: revision.id,
    authorEmail: author?.email ?? null,
    createdAt: revision.createdAt,
  };
};

/**
 * Save a slot draft, validating its content and guarding against a newer save.
 *
 * The editor posts the revision it loaded as `baseRevisionId`. If anything
 * newer exists — including the first revision of a slot someone else just
 * started — the save is refused with `conflict` until the editor passes
 * `overwrite`. Nothing is merged or locked: the editor either takes the newer
 * version or writes on top of it.
 */
export const saveSlotDraft = async (
  input: SaveSlotDraftInput,
): Promise<SaveDraftResult> => {
  const slot = await getSlotById(input.slotId);
  if (!slot) {
    throw new Error(`Slot ${input.slotId} not found`);
  }

  const blockType = await getBlockTypeByName(slot.blockName);
  if (!blockType) {
    throw new Error(
      `Block type "${slot.blockName}" for slot "${slot.name}" is not published`,
    );
  }

  // Removed fields are legitimate (Q4): the schema is opened at the root so a
  // key a deploy dropped validates, and the raw content is stored, not the
  // parsed copy, so that data survives the save.
  const validation = validateContent(blockType.jsonSchema, input.content, {
    allowAdditionalFields: true,
  });
  if (!validation.success) {
    return {
      ok: false,
      reason: "invalid",
      issues: formatIssues(validation.issues),
    };
  }

  const latest = await getLatestRevision("slot", slot.id);
  const newer = latest && latest.id !== input.baseRevisionId;

  if (newer && !input.overwrite) {
    return {
      ok: false,
      reason: "conflict",
      newer: await describeConflict(latest),
    };
  }

  const revision = await createRevision({
    targetType: "slot",
    targetId: slot.id,
    content: input.content,
    createdBy: input.actorId,
  });

  return { ok: true, revision };
};
