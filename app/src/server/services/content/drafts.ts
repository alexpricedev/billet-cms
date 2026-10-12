/**
 * The validated write layer.
 *
 * Every save the CMS makes goes through a function here — the forms call them
 * now, and the MCP server in a later phase will be a thin wrapper over the same
 * functions. Two rules hold for all of them:
 *
 * 1. **Validate before writing.** Content is checked against the JSON Schema
 *    the site published, rebuilt as a Zod schema, so a stored revision is one
 *    the site will accept when it reads it back. Unknown top-level keys are
 *    refused: removed fields (Q4) are carried through from the revision the
 *    editor loaded, never accepted from the client.
 * 2. **Never write over someone else's work silently.** A save names the
 *    revision it was based on; if a newer one exists the caller gets a conflict
 *    to show the editor, not a row. The check and the insert run in one
 *    transaction, under a row lock on the slot, so two saves can't both pass.
 */
import type { ValidationIssue } from "@alexpricedev/billet-cms/schema";
import { validateContent } from "@alexpricedev/billet-cms/schema";
import type { SQL } from "bun";
import { findUserById } from "../auth";
import { db } from "../database";
import { type BlockTypeRecord, getBlockTypeByName } from "./definitions";
import {
  createRevision,
  getLatestRevision,
  getRevisionById,
  type RevisionRecord,
} from "./revisions";
import { getSlotById, type SlotRecord } from "./slots";

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
  /**
   * The slot, when the caller already has it. Passing it avoids reading the row
   * twice — the controllers load it to build the form and to check the block
   * type, then hand it straight back here.
   */
  slot?: SlotRecord;
  /** The block type, for the same reason. */
  blockType?: BlockTypeRecord;
  content: Record<string, unknown>;
  /** The revision the editor loaded; null when there was none. */
  baseRevisionId: string | null;
  /** The identity saving, for `created_by`. */
  actorId: string | null;
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
 * Copy through any field the base revision carried that the current schema no
 * longer declares (Q4).
 *
 * A deploy can drop a field; the value stays in every revision written while it
 * existed. The editor's form has no control for it, so a plain save would drop
 * it, and accepting it from the client would let anyone write arbitrary keys.
 * The write layer is the one place that can add it back: it reads the revision
 * the editor loaded and re-attaches exactly the fields the schema no longer
 * knows, leaving everything the client did send to validation.
 */
const carryRemovedFields = async (
  content: Record<string, unknown>,
  slot: SlotRecord,
  blockType: BlockTypeRecord,
  baseRevisionId: string | null,
  sql: SQL,
): Promise<Record<string, unknown>> => {
  if (!baseRevisionId) return content;

  const base = await getRevisionById(baseRevisionId, sql);
  if (!base) return content;
  if (base.targetType !== "slot" || base.targetId !== slot.id) return content;

  const known = new Set(blockType.fields.map((field) => field.name));
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base.content)) {
    if (!known.has(key) && !(key in content)) carried[key] = value;
  }

  return { ...carried, ...content };
};

/**
 * Save a slot draft, validating its content and guarding against a newer save.
 *
 * The editor posts the revision it loaded as `baseRevisionId`. If anything
 * newer exists the save is refused with `conflict`, and the caller re-renders
 * the form pointing `baseRevisionId` at that newer revision — so a second save
 * is a deliberate overwrite of what the editor has now seen, rather than a flag
 * that bypasses the check. Nothing is merged or locked beyond the write itself.
 */
export const saveSlotDraft = async (
  input: SaveSlotDraftInput,
): Promise<SaveDraftResult> => {
  const slot = input.slot ?? (await getSlotById(input.slotId));
  if (!slot) {
    throw new Error(`Slot ${input.slotId} not found`);
  }

  const blockType =
    input.blockType ?? (await getBlockTypeByName(slot.blockName));
  if (!blockType) {
    throw new Error(
      `Block type "${slot.blockName}" for slot "${slot.name}" is not published`,
    );
  }

  // Strict: a key the block doesn't declare is refused. Removed fields are
  // re-attached below from the base revision, so they never need to pass here.
  const validation = validateContent(blockType.jsonSchema, input.content);
  if (!validation.success) {
    return {
      ok: false,
      reason: "invalid",
      issues: formatIssues(validation.issues),
    };
  }

  const outcome = await db.begin(async (tx) => {
    // The lock serialises every save to this slot. Without it two editors can
    // both read the same "latest", both decide they are current, and both
    // insert — the second silently on top of the first. Held until the
    // transaction ends, so the conflict check and the insert are one step.
    const locked = await tx`
      SELECT id FROM cms_slots WHERE id = ${slot.id} FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new Error(`Slot ${slot.id} not found`);
    }

    const latest = await getLatestRevision("slot", slot.id, tx);
    if (latest && latest.id !== input.baseRevisionId) {
      return { kind: "conflict" as const, newer: latest };
    }

    const content = await carryRemovedFields(
      input.content,
      slot,
      blockType,
      input.baseRevisionId,
      tx,
    );

    const revision = await createRevision(
      {
        targetType: "slot",
        targetId: slot.id,
        content,
        createdBy: input.actorId,
      },
      tx,
    );

    return { kind: "saved" as const, revision };
  });

  if (outcome.kind === "conflict") {
    return {
      ok: false,
      reason: "conflict",
      newer: await describeConflict(outcome.newer),
    };
  }

  return { ok: true, revision: outcome.revision };
};
