/**
 * Validating a page's content against its page type.
 *
 * A page's content is a list of blocks, each a block type's fields plus a
 * `type` discriminator — the same shape `pageTypeContentSchema` publishes, so
 * the schema the site checks is the one the CMS validates against. Two layers
 * are in play and both have to hold:
 *
 * 1. **Each block's fields** against the block type's stored JSON Schema, the
 *    way a slot's content is checked. Unknown top-level fields inside a block
 *    are tolerated (Q4): a deploy can drop a field and the value stays in the
 *    revision, so a strict parse would turn editing into data loss.
 * 2. **The page type's rules** — which blocks are allowed, which are required,
 *    and per-block limits such as `{ hero: { max: 1, position: "top" } }`. These
 *    are not in the JSON Schema (it describes one block at a time), which is why
 *    they live here.
 *
 * The two tolerances are separate because the two kinds of flag are not alike.
 * A block whose type a deploy *removed* (`allowUnavailableBlocks`) can't be
 * rendered by the site, so a save carries it and a publish refuses it. A block
 * the page type no longer *allows* (`allowNotAllowedBlocks`) is still a
 * published, renderable block — only the page type's own rule changed — so both
 * a save and a publish tolerate it, or a page that holds one could never be
 * saved or published again (review round 2). A save additionally tolerates a
 * removed *field*, the same way it tolerates a removed block.
 */
import { validateContent } from "@alexpricedev/billet-cms/schema";
import type { BlockTypeRecord, PageTypeRecord } from "./definitions";
import type { FieldIssue } from "./drafts";

/** One block in a page's stored content: its fields plus the `type`. */
export interface PageBlock {
  type: string;
  [key: string]: unknown;
}

/** The content of one page revision. */
export interface PageContent {
  blocks: PageBlock[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Read a stored revision's content into blocks, tolerating a shape we don't
 * recognise.
 *
 * A revision is written by this CMS, so the shape should always be right; a
 * hand-edited row or an older format reads as an empty page rather than
 * throwing inside a render.
 */
export const asPageContent = (
  content: Record<string, unknown>,
): PageContent => {
  const blocks = content.blocks;
  if (!Array.isArray(blocks)) return { blocks: [] };

  const parsed: PageBlock[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record || typeof record.type !== "string") continue;
    parsed.push({ ...record, type: record.type });
  }
  return { blocks: parsed };
};

/** A block whose type isn't usable, with the reason the form flags it. */
export interface UnavailableBlock {
  index: number;
  type: string;
  reason: "missing" | "removed" | "not-allowed";
}

/**
 * The blocks a page carries that its page type can no longer edit.
 *
 * A removed or unknown block type has no published field metadata, so the form
 * cannot generate controls for it; a block the page type no longer allows is
 * outside the contract. Both are flagged and left untouched until the editor
 * removes them or a deploy restores them — never deleted by a save.
 */
export const findUnavailableBlocks = (
  pageType: PageTypeRecord,
  blocks: PageBlock[],
  blockTypes: Map<string, BlockTypeRecord>,
): UnavailableBlock[] => {
  const allowed = new Set(pageType.allowedBlocks);
  const unavailable: UnavailableBlock[] = [];

  blocks.forEach((block, index) => {
    const blockType = blockTypes.get(block.type);
    if (!blockType || blockType.removedAt) {
      unavailable.push({
        index,
        type: block.type,
        reason: blockType?.removedAt ? "removed" : "missing",
      });
      return;
    }
    if (!allowed.has(block.type)) {
      unavailable.push({ index, type: block.type, reason: "not-allowed" });
    }
  });

  return unavailable;
};

/**
 * Put the blocks a save couldn't carry back where they were.
 *
 * The editor's form has no controls for a block whose type isn't editable, so
 * with JavaScript on the client drops it from what it submits. Appending the
 * missing blocks at the end would move a removed hero below the blocks that
 * followed it, so each is re-inserted at its original index (clamped to the
 * submitted list) instead (review round 1). The submitted blocks keep their own
 * order; only the blocks the client couldn't send are restored.
 *
 * `removedIndexes` names the flagged blocks the editor explicitly removed with
 * the form's Remove control (review round 2). The client can't serialize those
 * blocks' fields, so their removal is a separate marker; the block at such an
 * index is *not* carried back. The data stays in the older revisions.
 */
export const mergeUnavailableBlocks = (
  submitted: PageBlock[],
  base: PageBlock[],
  unavailable: UnavailableBlock[],
  removedIndexes: number[] = [],
): PageBlock[] => {
  const removed = new Set(removedIndexes);
  const missing: { index: number; block: PageBlock }[] = [];
  for (const entry of unavailable) {
    if (removed.has(entry.index)) continue;
    const block = base[entry.index];
    if (!block) continue;
    if (submitted.some((candidate) => candidate.type === block.type)) continue;
    missing.push({ index: entry.index, block });
  }
  if (missing.length === 0) return submitted;

  missing.sort((a, b) => a.index - b.index);
  const merged = [...submitted];
  for (const { index, block } of missing) {
    merged.splice(Math.min(index, merged.length), 0, block);
  }
  return merged;
};

export interface ValidatePageOptions {
  /** Carry a block whose type isn't published instead of refusing it (Q4). */
  allowUnavailableBlocks?: boolean;
  /**
   * Tolerate a block the page type no longer allows. Only the page type's own
   * rule changed — the block type is still published and renderable — so a save
   * and a publish both allow it (review round 2).
   */
  allowNotAllowedBlocks?: boolean;
}

export type ValidatePageResult =
  | { ok: true; content: PageContent }
  | { ok: false; issues: FieldIssue[] };

/**
 * Validate a page's blocks against the page type and the block schemas.
 *
 * Field paths are dotted and prefixed with the block's index
 * (`blocks.2.heading`) so the form can point at the control that failed, the
 * same way a slot's issues name a field. The limits run last: a page whose
 * blocks are invalid is reported by the shapes first, not by "add a hero" when
 * the hero that is there has a bad field.
 */
export const validatePageContent = (
  pageType: PageTypeRecord,
  blockTypes: Map<string, BlockTypeRecord>,
  content: PageContent,
  options: ValidatePageOptions = {},
): ValidatePageResult => {
  const issues: FieldIssue[] = [];
  const allowed = new Set(pageType.allowedBlocks);

  content.blocks.forEach((block, index) => {
    const at = `blocks.${index}`;
    const blockType = blockTypes.get(block.type);

    if (!blockType || blockType.removedAt) {
      if (options.allowUnavailableBlocks) return;
      issues.push({
        path: at,
        message: `The "${block.type}" block is no longer published. Remove it and save again.`,
      });
      return;
    }

    // A tolerated not-allowed block falls through to the field check below: the
    // page type's rule is waived, but the block type's own schema still holds.
    if (!allowed.has(block.type) && !options.allowNotAllowedBlocks) {
      issues.push({
        path: at,
        message: `The "${block.type}" block isn't allowed on this page type.`,
      });
      return;
    }

    // `type` is the discriminator, not a field, so it is removed before the
    // block's own schema sees it.
    const { type: _type, ...fields } = block;
    const validation = validateContent(blockType.jsonSchema, fields, {
      allowAdditionalFields: true,
    });
    if (!validation.success) {
      for (const issue of validation.issues) {
        issues.push({
          path: `${at}.${issue.path.join(".") || "(content)"}`,
          message: issue.message,
        });
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };

  const limitIssues = checkPageLimits(pageType, content.blocks);
  if (limitIssues.length > 0) return { ok: false, issues: limitIssues };

  return { ok: true, content };
};

/**
 * The page type's required blocks and per-block limits.
 *
 * `position` is `"top"` or `"bottom"`: a hero at the top means the hero is the
 * first block, a footer CTA at the bottom means it is the last. A type limited
 * to `max: 1, position: "top"` therefore reads as "exactly one, and it leads" —
 * the constraint the spec's "one hero, at the top" names.
 *
 * The messages name the block by its type name. A block label would read nicer,
 * but the metadata carries none today (labels are deferred to the UI refresh),
 * so the messages use the name the editor sees on the block.
 */
export const checkPageLimits = (
  pageType: PageTypeRecord,
  blocks: PageBlock[],
): FieldIssue[] => {
  const issues: FieldIssue[] = [];

  for (const required of pageType.requiredBlocks) {
    if (!blocks.some((block) => block.type === required)) {
      issues.push({
        path: "blocks",
        message: `Add a "${required}" block — the page type requires one.`,
      });
    }
  }

  for (const [name, rawLimit] of Object.entries(pageType.limits)) {
    const limit = asRecord(rawLimit);
    if (!limit) continue;
    const positions = blocks
      .map((block, index) => (block.type === name ? index : -1))
      .filter((index) => index >= 0);

    const max = typeof limit.max === "number" ? limit.max : undefined;
    const min = typeof limit.min === "number" ? limit.min : undefined;

    if (max !== undefined && positions.length > max) {
      issues.push({
        path: "blocks",
        message: `Use no more than ${max} ${name} ${max === 1 ? "block" : "blocks"}.`,
      });
    }
    if (min !== undefined && positions.length < min) {
      issues.push({
        path: "blocks",
        message: `Add at least ${min} ${name} ${min === 1 ? "block" : "blocks"}.`,
      });
    }

    if (
      limit.position === "top" &&
      positions.length > 0 &&
      positions[0] !== 0
    ) {
      issues.push({
        path: "blocks",
        message: `The ${name} block has to be first.`,
      });
    }
    if (
      limit.position === "bottom" &&
      positions.length > 0 &&
      positions[positions.length - 1] !== blocks.length - 1
    ) {
      issues.push({
        path: "blocks",
        message: `The ${name} block has to be last.`,
      });
    }
  }

  return issues;
};
