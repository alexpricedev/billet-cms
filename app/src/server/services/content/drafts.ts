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
import {
  URL_PATTERN,
  URL_PATTERN_MESSAGE,
} from "@alexpricedev/billet-cms/fields";
import type { ValidationIssue } from "@alexpricedev/billet-cms/schema";
import { validateContent } from "@alexpricedev/billet-cms/schema";
import type { SQL } from "bun";
import { findUserById } from "../auth";
import { db } from "../database";
import { checkImageGuidance } from "../media/guidance";
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
  | {
      ok: true;
      revision: RevisionRecord;
      /**
       * Guidance the save went ahead over — currently a `minWidth` shortfall.
       * The caller shows them; they are not reasons the save failed.
       */
      warnings: FieldIssue[];
    }
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

/**
 * Rewrite a Zod issue into copy an editor can act on.
 *
 * The stored schema is compiled by Zod, whose messages name the validator
 * rather than the problem ("Too big: expected string to have <=80 characters",
 * "Invalid input", "Unrecognized key: \"nope\""). The form shows this text
 * beside the field's label, so it has to read as a sentence a person can fix.
 * The patterns are the shapes Zod 4 produces for the vocabulary's constraints;
 * anything unrecognised falls back to a plain generic line rather than leaking
 * schema jargon.
 */
const plainMessage = (message: string): string => {
  // The rich text nesting bound is already a sentence about the document, not
  // validator jargon, so it passes through unchanged rather than falling
  // through to the generic line (review round 1).
  if (/^Rich text lists may nest at most \d+ deep\.$/.test(message)) {
    return message;
  }

  if (/received undefined$/.test(message)) return "This field is required.";

  const tooBig = message.match(/^Too big: expected (\w+) to have <=(\d+)/);
  if (tooBig) {
    const [, kind, rawLimit] = tooBig;
    const limit = Number(rawLimit);
    if (kind === "string") {
      return `Use ${limit} ${limit === 1 ? "character" : "characters"} or fewer.`;
    }
    if (kind === "array")
      return `Add no more than ${limit} ${limit === 1 ? "item" : "items"}.`;
    return "This value is too large.";
  }

  const tooSmall = message.match(/^Too small: expected (\w+) to have >=(\d+)/);
  if (tooSmall) {
    const [, kind, rawLimit] = tooSmall;
    const limit = Number(rawLimit);
    if (kind === "string") {
      return `Use at least ${limit} ${limit === 1 ? "character" : "characters"}.`;
    }
    if (kind === "array")
      return `Add at least ${limit} ${limit === 1 ? "item" : "items"}.`;
    return "This value is too small.";
  }

  if (/^Invalid input: expected string, received/.test(message)) {
    return "Enter text.";
  }
  const unknown = message.match(/^Unrecognized keys?: (.+)$/);
  if (unknown) return `Unknown field: ${unknown[1]}.`;
  if (message === "Invalid UUID") return "Enter a valid id.";
  if (message.startsWith("Invalid string: must match pattern")) {
    // The link field stores the allowlist as a JSON Schema `pattern`, so a bad
    // link reaches the editor as "must match pattern <source>". Name the link
    // when it is that allowlist that failed, rather than a generic "expected
    // format" that hides what a usable link looks like.
    if (message.includes(URL_PATTERN.source)) return URL_PATTERN_MESSAGE;
    return "This value isn't in the expected format.";
  }
  return "This value isn't valid.";
};

/**
 * Walk a dotted issue path into the content it came from.
 *
 * Numeric segments address list entries; string segments address object keys.
 * Returns `undefined` as soon as the path leaves the value, so a path that
 * doesn't line up with the content is treated as "no parent object" rather than
 * throwing.
 */
const valueAtPath = (content: unknown, path: (string | number)[]): unknown => {
  let current: unknown = content;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
};

/** True when a value is a page-mode link that hasn't chosen a page yet. */
const isUnchosenPageLink = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "page") return false;
  const pageId = record.pageId;
  // A missing `pageId`, or one left as an empty string, is "no page chosen yet".
  // A *malformed* non-empty id is a different problem and keeps its own message.
  return pageId === undefined || pageId === null || pageId === "";
};

/** True when a value is a url-mode link whose `url` fails the shared allowlist. */
const isBadLinkUrl = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { type?: unknown; url?: unknown };
  return (
    record.type === "url" &&
    typeof record.url === "string" &&
    !URL_PATTERN.test(record.url)
  );
};

/**
 * Rewrite the validator's issues into copy an editor can act on.
 *
 * Shared with the publish path, which validates a stored revision the same way
 * a save does and shows the same field-level messages. The content the issues
 * came from is what makes the link check precise: a bad `url` is a link whose
 * allowlist pattern failed, and "Choose a page." is only for a page-mode link
 * whose `pageId` is missing or blank, so a malformed id — or an unrelated field
 * that happens to be called `pageId` — gets its own plain message instead
 * (review round 1 follow-up).
 */
export const formatIssues = (
  issues: ValidationIssue[],
  content: unknown,
): FieldIssue[] =>
  issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(content)";
    const last = issue.path[issue.path.length - 1];
    const parent = valueAtPath(content, issue.path.slice(0, -1));
    const value = valueAtPath(content, issue.path);
    const message = isBadLinkUrl(value)
      ? URL_PATTERN_MESSAGE
      : last === "pageId" && isUnchosenPageLink(parent)
        ? "Choose a page."
        : plainMessage(issue.message);
    return { path, message };
  });

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
  // A deploy removed the block type (Q4): the form is read-only, and the write
  // layer refuses the slot too rather than trusting every caller to check.
  if (blockType.removedAt) {
    throw new Error(
      `Block type "${slot.blockName}" for slot "${slot.name}" is no longer published`,
    );
  }

  // Strict: a key the block doesn't declare is refused. Removed fields are
  // re-attached below from the base revision, so they never need to pass here.
  const validation = validateContent(blockType.jsonSchema, input.content);
  if (!validation.success) {
    return {
      ok: false,
      reason: "invalid",
      issues: formatIssues(validation.issues, input.content),
    };
  }

  // The schema can only say an image reference is a UUID; whether the picture
  // behind it is the right shape, or big enough for the field, is a `cms_media`
  // row. A wrong shape refuses the save; a short width does not — a narrow hero
  // still renders, so it is a warning the caller shows and the save goes ahead
  // (part 10).
  const guidance = await checkImageGuidance(blockType.fields, input.content);
  if (guidance.issues.length > 0) {
    return { ok: false, reason: "invalid", issues: guidance.issues };
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

  return { ok: true, revision: outcome.revision, warnings: guidance.warnings };
};
