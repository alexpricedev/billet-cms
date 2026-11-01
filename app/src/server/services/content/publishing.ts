/**
 * Publishing, history and restore.
 *
 * A slot's content is published per slot: `cms_slots.published_revision_id`
 * points at the revision the site renders, and publishing bumps
 * `cms_meta.content_version` so a site's cache drops within a second (Q3).
 * Nothing is overwritten — a publish is a change of pointer, and every save
 * stays in `cms_revisions` — so history is a query and restore is a copy of an
 * old revision into a new draft.
 *
 * Publishing validates the revision it is about to make live against the
 * block's published schema, the same way a save does. A draft that no longer
 * validates (a deploy changed the block under it) is refused with field-level
 * messages rather than going live and being skipped by the site at read time.
 */
import type { SQL } from "bun";
import { db } from "../database";
import {
  findDeletedImageIssues,
  findImageGuidance,
  loadMediaSizes,
  lockReferencedMedia,
  referencedMediaIds,
} from "../media/guidance";
import { type BlockTypeRecord, getBlockTypeByName } from "./definitions";
import { blockContentIssues, type FieldIssue } from "./drafts";
import { buildExcerpt, firstTextField } from "./history-excerpt";
import {
  createRevision,
  getLatestRevision,
  getRevisionById,
  type RevisionRecord,
} from "./revisions";
import { getSlotById, type SlotRecord } from "./slots";

export type PublishSlotResult =
  | {
      ok: true;
      revisionId: string;
      contentVersion: number;
      /** False when the slot already pointed at this revision. */
      changed: boolean;
      /**
       * Guidance the publish went ahead over — currently a narrow image.
       * Allowed on purpose: the width is a site guideline, and refusing here
       * would only move the refusal the save no longer makes (part 10).
       */
      warnings: FieldIssue[];
    }
  | { ok: false; reason: "no-draft" }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
  | {
      ok: false;
      reason: "stale";
      /** The newer revision that arrived after the one named. */
      latestRevisionId: string;
    };

export interface PublishSlotInput {
  slotId: string;
  /** The slot row, when the caller already has it. */
  slot?: SlotRecord;
  /** The block type, for the same reason. */
  blockType?: BlockTypeRecord;
  /** Publish this revision; defaults to the newest draft. */
  revisionId?: string;
  /**
   * Refuse when a newer revision exists than the one named.
   *
   * The form posts the revision it rendered, so an editor publishes what they
   * saw rather than a colleague's newer draft arriving under them. The check
   * runs under the slot's row lock, so the newest revision cannot change
   * between "is this still the newest?" and the pointer write.
   */
  requireLatest?: boolean;
}

interface LockedSlotRow {
  published_revision_id: string | null;
}

/**
 * Read `cms_meta.content_version`, the counter the site's cache polls.
 *
 * Exported for the page publish path, which bumps the same counter: a page and a
 * slot share one version, because a site's cache is invalidated per process and
 * not per target.
 */
export const readContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql`
    SELECT content_version FROM cms_meta WHERE id = 1
  `) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

/** Bump `content_version` by one inside a transaction; returns the new value. */
export const bumpContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql`
    UPDATE cms_meta
    SET content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    RETURNING content_version
  `) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

/**
 * Make a revision the one the site renders.
 *
 * The pointer update and the version bump share one transaction under a row
 * lock on the slot, so two publishes can't interleave a pointer write with the
 * other's version bump. Re-publishing the revision a slot already points at
 * writes nothing and leaves `content_version` alone, so a saved-but-unchanged
 * click doesn't churn every site's cache.
 */
export const publishSlot = async (
  input: PublishSlotInput,
): Promise<PublishSlotResult> => {
  const slot = input.slot ?? (await getSlotById(input.slotId));
  if (!slot) throw new Error(`Slot ${input.slotId} not found`);

  const blockType =
    input.blockType ?? (await getBlockTypeByName(slot.blockName));
  if (!blockType) {
    throw new Error(
      `Block type "${slot.blockName}" for slot "${slot.name}" is not published`,
    );
  }
  if (blockType.removedAt) {
    throw new Error(
      `Block type "${slot.blockName}" for slot "${slot.name}" is no longer published`,
    );
  }

  return await db.begin(async (tx) => {
    const locked = (await tx`
      SELECT published_revision_id FROM cms_slots
      WHERE id = ${slot.id} FOR UPDATE
    `) as LockedSlotRow[];
    if (locked.length === 0) throw new Error(`Slot ${slot.id} not found`);

    const revision = input.revisionId
      ? await getRevisionById(input.revisionId, tx)
      : await getLatestRevision("slot", slot.id, tx);

    // A revision that belongs to another target, or none at all: nothing to
    // publish. Not an error the caller did wrong — an editor can hit Publish
    // before saving anything.
    if (revision?.targetType !== "slot" || revision.targetId !== slot.id) {
      return { ok: false as const, reason: "no-draft" as const };
    }

    // The editor asked to publish the revision they were shown. If someone has
    // saved since, that revision is no longer the newest: stop and let them
    // decide rather than putting work they haven't seen live.
    if (input.requireLatest) {
      const latest = await getLatestRevision("slot", slot.id, tx);
      if (latest && latest.id !== revision.id) {
        return {
          ok: false as const,
          reason: "stale" as const,
          latestRevisionId: latest.id,
        };
      }
    }

    // Removed top-level fields are tolerated, exactly as a save tolerates them
    // (Q4): they are carried from the base revision and never authored here.
    // Button text is left out on purpose: it is an authoring rule, and this
    // revision was already gated when it was saved. Re-running it here would
    // refuse a draft written before the rule existed (see `blockContentIssues`).
    const issues = blockContentIssues(blockType, revision.content, {
      allowAdditionalFields: true,
      skipLinkText: true,
    });
    if (issues.length > 0) {
      return { ok: false as const, reason: "invalid" as const, issues };
    }

    if (locked[0].published_revision_id === revision.id) {
      return {
        ok: true as const,
        revisionId: revision.id,
        contentVersion: await readContentVersion(tx),
        changed: false,
        // Nothing was published, so there is no publish to warn about. The
        // button is disabled in this state anyway.
        warnings: [],
      };
    }

    // Hold the images this revision references for the length of the write, so
    // a concurrent delete can't remove one between here and the pointer write
    // (review r1-4). The same read answers the deleted-image check (Q1): an
    // image deleted while this revision sat as a draft has no row here, so the
    // publish is refused with a message on the block and nothing goes live.
    // Saving the same draft stayed legal, so the editor can still choose another.
    const existingMedia = await lockReferencedMedia(tx, revision.content);
    const deletedImages = findDeletedImageIssues(
      blockType.fields,
      revision.content,
      existingMedia,
    );
    if (deletedImages.length > 0) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        issues: deletedImages,
      };
    }

    // A narrow image does not refuse the publish (part 10): the width is a
    // fidelity guideline, and blocking here would put back the refusal the save
    // just stopped making. The warning rides back with the result so the editor
    // is told what is live. The sizes come from the rows already locked above,
    // in the transaction holding them.
    const guidance = findImageGuidance(
      blockType.fields,
      revision.content,
      await loadMediaSizes(
        referencedMediaIds(blockType.fields, revision.content),
        tx,
      ),
    );

    await tx`
      UPDATE cms_slots
      SET published_revision_id = ${revision.id}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${slot.id}
    `;
    const contentVersion = await bumpContentVersion(tx);

    return {
      ok: true as const,
      revisionId: revision.id,
      contentVersion,
      changed: true,
      warnings: guidance.warnings,
    };
  });
};

export interface SlotRevisionSummary {
  id: string;
  createdAt: Date;
  /** The identity that saved it, when the site's view still exposes them. */
  authorEmail: string | null;
  /** The revision the site is currently rendering. */
  isPublished: boolean;
  /** The newest revision, which the editor's form would load as the draft. */
  isLatest: boolean;
  /**
   * Whether this row is the draft: the newest revision *and* not the one the
   * site renders. Both are needed — after a restore-then-publish the newest row
   * is live, and calling it "Current draft" left an older row looking like the
   * draft the editor had open.
   */
  isDraft: boolean;
  /** When the revision this one restored was saved; null if not a restore. */
  restoredFromAt: Date | null;
  /**
   * One line of the revision's words — the slot's first text field — so two
   * same-day versions can be told apart. Empty when it has no text to show.
   */
  excerpt: string;
}

/** How many revisions one history page shows. */
export const HISTORY_PAGE_SIZE = 50;

/** One page of a slot's history, and whether older revisions remain. */
export interface SlotHistoryPage {
  revisions: SlotRevisionSummary[];
  /** True when revisions older than this page exist. */
  hasOlder: boolean;
}

/**
 * The revisions of one slot, newest first, in pages.
 *
 * `cms_identities` is the site's own view, so an author whose account the site
 * has since removed reads back as `null` rather than dropping the row: the
 * revision is still history.
 */
export const listSlotHistory = async (
  slot: SlotRecord,
  options: { before?: string | null } = {},
): Promise<SlotHistoryPage> => {
  const before = options.before ?? null;
  const rows = (await db`
    SELECT r.id, r.created_at, r.content, i.email AS author_email,
      src.created_at AS restored_from_at
    FROM cms_revisions r
    LEFT JOIN cms_identities i ON i.id = r.created_by
    LEFT JOIN cms_revisions src ON src.id = r.restored_from
    WHERE r.target_type = 'slot' AND r.target_id = ${slot.id}
      AND (
        ${before}::uuid IS NULL
        OR (r.created_at, r.id) < (
          SELECT b.created_at, b.id
          FROM cms_revisions b
          WHERE b.id = ${before}::uuid
            AND b.target_type = 'slot' AND b.target_id = ${slot.id}
        )
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${HISTORY_PAGE_SIZE + 1}
  `) as {
    id: string;
    created_at: Date;
    content: Record<string, unknown>;
    author_email: string | null;
    restored_from_at: Date | null;
  }[];

  // The block's field metadata names its text fields, so the excerpt reads the
  // first *text* field rather than whichever value happens to be first. One
  // read for the whole page of revisions, not one per row. A block type the
  // site no longer publishes has no fields to read, so its rows show no excerpt.
  const blockType = await getBlockTypeByName(slot.blockName);

  // One extra row is fetched only to answer "is there an older page?"; it is not
  // shown. The page itself is the newest `HISTORY_PAGE_SIZE`.
  const hasOlder = rows.length > HISTORY_PAGE_SIZE;
  const page = rows.slice(0, HISTORY_PAGE_SIZE);

  return {
    revisions: page.map((row, index) => {
      const isPublished = row.id === slot.publishedRevisionId;
      // Only the first page holds the newest revision.
      const isLatest = before === null && index === 0;
      return {
        id: row.id,
        createdAt: row.created_at,
        authorEmail: row.author_email,
        isPublished,
        isLatest,
        isDraft: isLatest && !isPublished,
        restoredFromAt: row.restored_from_at,
        excerpt: blockType
          ? buildExcerpt([firstTextField(blockType.fields, row.content)])
          : "",
      };
    }),
    hasOlder,
  };
};

export type RestoreSlotResult =
  | { ok: true; revision: RevisionRecord }
  | { ok: false; reason: "not-found" };

export interface RestoreSlotInput {
  slotId: string;
  /** The historical revision to copy into a new draft. */
  revisionId: string;
  slot?: SlotRecord;
  /** The identity restoring, for the new revision's `created_by`. */
  actorId: string | null;
}

/**
 * Restore an old revision by copying it into a new draft.
 *
 * Nothing is rewritten: the copy is a fresh immutable revision, the newest
 * draft, and the old one stays where it is. Making the copy live is a separate
 * Publish, so restoring is not the same action as publishing a change.
 */
export const restoreSlotRevision = async (
  input: RestoreSlotInput,
): Promise<RestoreSlotResult> => {
  const slot = input.slot ?? (await getSlotById(input.slotId));
  if (!slot) throw new Error(`Slot ${input.slotId} not found`);

  const source = await getRevisionById(input.revisionId);
  if (source?.targetType !== "slot" || source.targetId !== slot.id) {
    return { ok: false, reason: "not-found" };
  }

  const revision = await createRevision({
    targetType: "slot",
    targetId: slot.id,
    content: source.content,
    createdBy: input.actorId,
    restoredFrom: source.id,
  });

  return { ok: true, revision };
};
