/**
 * The validated write layer for pages: save, publish, history and restore.
 *
 * It is the same shape as the slot layer in `drafts.ts`/`publishing.ts`, with
 * the page's extra dimension: content is a list of blocks validated against the
 * page type's rules. The two invariants hold here unchanged.
 *
 * 1. **Validate before writing.** Each block's fields are checked against the
 *    block type's published JSON Schema and the list against the page type's
 *    allowed/required blocks and limits. A save tolerates a block whose type a
 *    deploy removed (Q4) so the rest of the page is never lost; a publish does
 *    not, because a page the site would skip must not go live.
 * 2. **Never write over someone else's work silently.** The revision a save was
 *    based on is named; a newer one means a conflict to show the editor, and the
 *    check and the insert share one transaction under a row lock on the page.
 *
 * Publishing is per page, and a page's published revision bump is the same
 * `cms_meta.content_version` a slot publish bumps, so a site's cache drops for
 * either. Nothing is overwritten — a publish is a change of pointer, and every
 * save stays in `cms_revisions` — so history is a query and restore is a copy.
 */
import type { SQL } from "bun";
import { findUserById } from "../auth";
import { db } from "../database";
import {
  findDeletedImageIssues,
  findImageGuidance,
  type ImageGuidance,
  loadMediaSizes,
  lockReferencedMedia,
  referencedMediaIds,
} from "../media/guidance";
import {
  type BlockTypeRecord,
  getPageTypeByName,
  listBlockTypes,
} from "./definitions";
import type { FieldIssue, RevisionConflict } from "./drafts";
import { firstTextField, pageExcerpt } from "./history-excerpt";
import {
  asPageContent,
  findUnavailableBlocks,
  mergeUnavailableBlocks,
  type PageContent,
  validatePageContent,
} from "./page-content";
import {
  applyDraftUrl,
  applyPageSettings,
  type DraftUrlMove,
  duplicateUrlMessage,
  type FieldSettingIssue,
  getPageById,
  type PageRecord,
  type PageSettingsInput,
  type PageSettingsValues,
  resolveWritablePageType,
  SOCIAL_IMAGE_ISSUE,
  SocialImageMissingError,
  validatePageSettings,
} from "./pages";
import { bumpContentVersion, readContentVersion } from "./publishing";
import {
  createRevision,
  getLatestRevision,
  getRevisionById,
  type RevisionRecord,
} from "./revisions";

/** All published block types, keyed by name, for one page's validation. */
const blockTypesByName = async (): Promise<Map<string, BlockTypeRecord>> =>
  new Map(
    (await listBlockTypes()).map((blockType) => [blockType.name, blockType]),
  );

/**
 * Enforce every block's image guidance across a page's content.
 *
 * Each block is checked against its own metadata tree, and a finding is reported
 * with the block's own index so the form points the message at the right
 * control, exactly as the schema issues are. The referenced ids are gathered
 * across every block first and loaded in one query, rather than one `cms_media`
 * read per block (review r1-11).
 *
 * A wrong aspect is an issue the save is refused on; a short width comes back
 * as a warning beside it (part 10).
 */
const blockImageGuidance = async (
  blockTypes: Map<string, BlockTypeRecord>,
  content: PageContent,
  sql?: SQL,
): Promise<ImageGuidance> => {
  const blocks: {
    index: number;
    fields: BlockTypeRecord["fields"];
    content: Record<string, unknown>;
  }[] = [];
  const ids = new Set<string>();

  for (const [index, block] of content.blocks.entries()) {
    const blockType = blockTypes.get(block.type);
    if (!blockType) continue;
    const { type: _type, ...fields } = block;
    const blockContent = fields as Record<string, unknown>;
    blocks.push({ index, fields: blockType.fields, content: blockContent });
    for (const id of referencedMediaIds(blockType.fields, blockContent)) {
      ids.add(id);
    }
  }

  const sizes = await loadMediaSizes([...ids], sql);
  const issues: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  for (const block of blocks) {
    const guidance = findImageGuidance(block.fields, block.content, sizes);
    for (const issue of guidance.issues) {
      issues.push({
        path: `blocks.${block.index}.${issue.path}`,
        message: issue.message,
      });
    }
    for (const warning of guidance.warnings) {
      warnings.push({
        path: `blocks.${block.index}.${warning.path}`,
        message: warning.message,
      });
    }
  }
  return { issues, warnings };
};

/**
 * The page's deleted-image issues, from the media a publish already loaded.
 *
 * A save tolerates a block whose image row is gone (a draft is never lost to a
 * deleted upload); a publish refuses it instead (Q1), so a live page can't point
 * at a file that no longer exists. The paths carry the block's index exactly as
 * the schema and guidance issues do, so the message lands on the block that
 * names the missing image. The ids come from the publish's own lock read, so
 * this costs a map lookup per reference, not a query per block.
 */
const blockDeletedImageIssues = (
  blockTypes: Map<string, BlockTypeRecord>,
  content: PageContent,
  existing: ReadonlySet<string>,
): FieldIssue[] => {
  const issues: FieldIssue[] = [];
  content.blocks.forEach((block, index) => {
    const blockType = blockTypes.get(block.type);
    if (!blockType) return;
    const { type: _type, ...fields } = block;
    for (const issue of findDeletedImageIssues(
      blockType.fields,
      fields as Record<string, unknown>,
      existing,
    )) {
      issues.push({
        path: `blocks.${index}.${issue.path}`,
        message: issue.message,
      });
    }
  });
  return issues;
};

export type SavePageDraftResult =
  | {
      ok: true;
      revision: RevisionRecord;
      /** Guidance the save went ahead over — currently a narrow image. */
      warnings: FieldIssue[];
    }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
  | { ok: false; reason: "conflict"; newer: RevisionConflict };

export interface SavePageDraftInput {
  pageId: string;
  /** The page row, when the caller already has it. */
  page?: PageRecord;
  content: PageContent;
  /** The revision the editor loaded; null when there was none. */
  baseRevisionId: string | null;
  /**
   * Base-revision indices of flagged blocks the editor explicitly removed. The
   * form's Remove control sends these because the client cannot serialize a
   * flagged block's fields (review round 2).
   */
  removedBlockIndexes?: number[];
  /** The identity saving, for `created_by`. */
  actorId: string | null;
}

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

const pageTypeForWrite = async (page: PageRecord) => {
  const pageType = await getPageTypeByName(page.pageType);
  if (!pageType) {
    throw new Error(
      `Page type "${page.pageType}" for page "${page.url}" is not published`,
    );
  }
  return pageType;
};

/**
 * Put back any block a save couldn't carry (Q4).
 *
 * The editor's form has no controls for a block whose type a deploy removed, so
 * with JavaScript on the client cannot rebuild it and a save would drop it. The
 * write layer is the one place that can add it back: it reads the revision the
 * editor loaded and re-attaches exactly the unavailable blocks the submission
 * left out, leaving everything the client did send to validation. A block the
 * editor explicitly removed with the form's Remove control names its index in
 * `removedBlockIndexes` and is *not* carried back (review round 2); its data
 * stays in the older revisions. A removed block refuses to publish either way,
 * so its data is never silently lost.
 */
const carryUnavailableBlocks = async (
  page: PageRecord,
  pageType: Awaited<ReturnType<typeof pageTypeForWrite>>,
  blockTypes: Map<string, BlockTypeRecord>,
  submitted: PageContent,
  baseRevisionId: string | null,
  removedBlockIndexes: number[],
  sql: SQL,
): Promise<PageContent> => {
  if (!baseRevisionId) return submitted;

  const base = await getRevisionById(baseRevisionId, sql);
  if (base?.targetType !== "page" || base.targetId !== page.id)
    return submitted;

  const baseBlocks = asPageContent(base.content).blocks;
  const unavailable = findUnavailableBlocks(pageType, baseBlocks, blockTypes);
  return {
    blocks: mergeUnavailableBlocks(
      submitted.blocks,
      baseBlocks,
      unavailable,
      removedBlockIndexes,
    ),
  };
};

/**
 * Save a page draft.
 *
 * A block whose type a deploy removed is carried through untouched (Q4): a save
 * must not delete content because the code stopped describing it. A block the
 * page type no longer allows is tolerated too (review round 2), so a page that
 * holds one can still be saved. Everything else is validated against the page
 * type, so a draft is one the page type accepts before it is ever published.
 */
export const savePageDraft = async (
  input: SavePageDraftInput,
): Promise<SavePageDraftResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const pageType = await pageTypeForWrite(page);
  const blockTypes = await blockTypesByName();

  const validation = validatePageContent(pageType, blockTypes, input.content, {
    allowUnavailableBlocks: true,
    allowNotAllowedBlocks: true,
  });
  if (!validation.ok) {
    return { ok: false, reason: "invalid", issues: validation.issues };
  }

  const guidance = await blockImageGuidance(blockTypes, input.content);
  if (guidance.issues.length > 0) {
    return { ok: false, reason: "invalid", issues: guidance.issues };
  }

  const outcome = await db.begin(async (tx) => {
    const locked = await tx`
      SELECT id FROM cms_pages WHERE id = ${page.id} FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new Error(`Page ${page.id} not found`);
    }

    const latest = await getLatestRevision("page", page.id, tx);
    if (latest && latest.id !== input.baseRevisionId) {
      return { kind: "conflict" as const, newer: latest };
    }

    const revision = await createRevision(
      {
        targetType: "page",
        targetId: page.id,
        content: {
          blocks: (
            await carryUnavailableBlocks(
              page,
              pageType,
              blockTypes,
              input.content,
              input.baseRevisionId,
              input.removedBlockIndexes ?? [],
              tx,
            )
          ).blocks,
        },
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

export type SavePageResult =
  | {
      ok: true;
      revision: RevisionRecord;
      page: PageRecord;
      /** Guidance the save went ahead over — currently a narrow image. */
      warnings: FieldIssue[];
    }
  | { ok: false; reason: "settings"; issues: FieldSettingIssue[] }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
  | { ok: false; reason: "conflict"; newer: RevisionConflict };

export interface SavePageInput {
  pageId: string;
  /** The page row, when the caller already has it. */
  page?: PageRecord;
  /** The settings the editor typed, including the page type they chose. */
  settings: PageSettingsInput & { pageType: string };
  content: PageContent;
  /** The revision the editor loaded; null when there was none. */
  baseRevisionId: string | null;
  /** Base-revision indices of flagged blocks the editor explicitly removed. */
  removedBlockIndexes?: number[];
  actorId: string | null;
}

/**
 * Save a page's settings and its content together, atomically.
 *
 * The form submits both halves, and the editor expects one Save: the settings
 * must not be written, and a 301 must not be left behind, when the content half
 * the same submit carries is invalid (review round 1). So everything is
 * validated first — the settings, the page type the editor chose, the blocks
 * against it — and only then does one transaction write the settings, the
 * redirect, the new revision and the version bump. A conflict with a newer
 * revision is reported and writes nothing.
 */
export const savePage = async (
  input: SavePageInput,
): Promise<SavePageResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const settings = await validatePageSettings(input.settings);
  if (!settings.ok) {
    return { ok: false, reason: "settings", issues: settings.issues };
  }

  const pageType = await resolveWritablePageType(input.settings.pageType);
  if (!pageType) {
    return {
      ok: false,
      reason: "settings",
      issues: [{ path: "pageType", message: "Choose a published page type." }],
    };
  }

  const blockTypes = await blockTypesByName();
  const validation = validatePageContent(pageType, blockTypes, input.content, {
    allowUnavailableBlocks: true,
    allowNotAllowedBlocks: true,
  });
  if (!validation.ok) {
    return { ok: false, reason: "invalid", issues: validation.issues };
  }

  const guidance = await blockImageGuidance(blockTypes, input.content);
  if (guidance.issues.length > 0) {
    return { ok: false, reason: "invalid", issues: guidance.issues };
  }

  const outcome = await writePage(page, pageType, blockTypes, settings, input);

  if (outcome.kind === "duplicate" || outcome.kind === "settings") {
    return { ok: false, reason: "settings", issues: [outcome.issue] };
  }

  if (outcome.kind === "conflict") {
    return {
      ok: false,
      reason: "conflict",
      newer: await describeConflict(outcome.newer),
    };
  }

  return {
    ok: true,
    revision: outcome.revision,
    page: outcome.page,
    warnings: guidance.warnings,
  };
};

type PageWriteOutcome =
  | { kind: "saved"; revision: RevisionRecord; page: PageRecord }
  | { kind: "conflict"; newer: RevisionRecord }
  | { kind: "duplicate"; issue: FieldSettingIssue }
  /** A settings field stopped the write (the social image disappeared). */
  | { kind: "settings"; issue: FieldSettingIssue };

/**
 * The one transaction an atomic page save runs: lock, check the conflict, write
 * the settings and the redirect, insert the revision, carry any uneditable
 * block back into place. A unique-URL violation becomes a settings issue rather
 * than an uncaught throw, so the editor sees it beside the URL field.
 */
const writePage = async (
  page: PageRecord,
  pageType: Awaited<ReturnType<typeof pageTypeForWrite>>,
  blockTypes: Map<string, BlockTypeRecord>,
  settings: PageSettingsValues,
  input: SavePageInput,
): Promise<PageWriteOutcome> => {
  try {
    return await db.begin(async (tx) => {
      const locked = await tx`
        SELECT id FROM cms_pages WHERE id = ${page.id} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new Error(`Page ${page.id} not found`);
      }

      // The conflict is checked before anything is written: a newer revision
      // means this save is refused whole, not half-applied.
      const latest = await getLatestRevision("page", page.id, tx);
      if (latest && latest.id !== input.baseRevisionId) {
        return { kind: "conflict" as const, newer: latest };
      }

      const applied = await applyPageSettings(
        tx,
        page.id,
        settings,
        pageType.name,
        "draft",
      );

      const carried = await carryUnavailableBlocks(
        page,
        pageType,
        blockTypes,
        input.content,
        input.baseRevisionId,
        input.removedBlockIndexes ?? [],
        tx,
      );

      const revision = await createRevision(
        {
          targetType: "page",
          targetId: page.id,
          content: { blocks: carried.blocks },
          createdBy: input.actorId,
        },
        tx,
      );

      return { kind: "saved" as const, revision, page: applied.page };
    });
  } catch (error) {
    if (error instanceof SocialImageMissingError) {
      return { kind: "settings", issue: SOCIAL_IMAGE_ISSUE };
    }
    // Outside the rolled-back transaction: the owner of the URL is a committed
    // row, so this names the page the editor collided with (part 9).
    const message = await duplicateUrlMessage(error, settings.url);
    if (message) return { kind: "duplicate", issue: { path: "url", message } };
    throw error;
  }
};

export type PublishPageResult =
  | {
      ok: true;
      revisionId: string;
      contentVersion: number;
      changed: boolean;
      /** The address change this publish applied, for the editor's banner. */
      moved: DraftUrlMove | null;
      /** Guidance the publish went ahead over — currently a narrow image. */
      warnings: FieldIssue[];
    }
  | { ok: false; reason: "no-draft" }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
  /** A pending URL change lost its address to another page after it was saved. */
  | { ok: false; reason: "duplicate"; issue: FieldSettingIssue }
  | { ok: false; reason: "stale"; latestRevisionId: string };

export interface PublishPageInput {
  pageId: string;
  page?: PageRecord;
  /** Publish this revision; defaults to the newest draft. */
  revisionId?: string;
  /** Refuse when a newer revision exists than the one named. */
  requireLatest?: boolean;
}

/**
 * Make a page revision the one the site renders.
 *
 * The revision is validated without the save path's tolerance for a removed
 * block: putting such a page live would hand the site content it would skip, so
 * the editor is asked to remove the block first. A block the page type no longer
 * allows is tolerated (review round 2) — the block type is still published and
 * the site renders it — so a page that holds one can be published again. The
 * same refusals slots get apply — no draft, a no-longer-valid draft, a newer
 * draft than the one named.
 */
export const publishPage = async (
  input: PublishPageInput,
): Promise<PublishPageResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const pageType = await pageTypeForWrite(page);
  const blockTypes = await blockTypesByName();

  try {
    return await db.begin(async (tx) => {
      const locked = (await tx`
        SELECT published_revision_id, draft_url FROM cms_pages
        WHERE id = ${page.id} FOR UPDATE
      `) as {
        published_revision_id: string | null;
        draft_url: string | null;
      }[];
      if (locked.length === 0) throw new Error(`Page ${page.id} not found`);

      const latest = await getLatestRevision("page", page.id, tx);
      const revision = input.revisionId
        ? await getRevisionById(input.revisionId, tx)
        : latest;

      if (revision?.targetType !== "page" || revision.targetId !== page.id) {
        return { ok: false as const, reason: "no-draft" as const };
      }

      if (input.requireLatest && latest && latest.id !== revision.id) {
        return {
          ok: false as const,
          reason: "stale" as const,
          latestRevisionId: latest.id,
        };
      }

      // The queued address change belongs to the newest revision: publishing an
      // older one leaves it alone, because the draft that carried it is not what
      // goes live.
      const applyingDraftUrl =
        latest !== null &&
        latest.id === revision.id &&
        locked[0].draft_url !== null;

      // The revision is already live, so only a pending address change can be
      // applied (ticket #66: a URL-only save leaves the pointer alone). The
      // content is not changing, so the content checks below are skipped — a
      // queued move must not be refused for a block the live page already has.
      if (locked[0].published_revision_id === revision.id) {
        if (!applyingDraftUrl) {
          return {
            ok: true as const,
            revisionId: revision.id,
            contentVersion: await readContentVersion(tx),
            changed: false,
            moved: null,
            warnings: [],
          };
        }
        const moved = await applyDraftUrl(tx, page.id);
        return {
          ok: true as const,
          revisionId: revision.id,
          contentVersion: await bumpContentVersion(tx),
          changed: true,
          moved,
          warnings: [],
        };
      }

      // The revision was gated when it was saved, so publishing does not
      // re-run the authoring rule (see `ValidatePageOptions.skipLinkText`).
      const validation = validatePageContent(
        pageType,
        blockTypes,
        asPageContent(revision.content),
        { allowNotAllowedBlocks: true, skipLinkText: true },
      );
      if (!validation.ok) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          issues: validation.issues,
        };
      }

      // Hold the images this revision references for the length of the write, so
      // a concurrent delete can't remove one between here and the pointer write
      // (review r1-4). The same read answers the deleted-image check (Q1): an
      // image deleted while this revision sat as a draft has no row here, so the
      // publish is refused with a message on the block and nothing goes live.
      // Saving the same draft stayed legal, so the editor can still choose another.
      const existingMedia = await lockReferencedMedia(tx, revision.content);
      const deletedImages = blockDeletedImageIssues(
        blockTypes,
        asPageContent(revision.content),
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
      // just stopped making. The warning rides back so the editor is told what is
      // live. The read joins the transaction that already holds the rows.
      const guidance = await blockImageGuidance(
        blockTypes,
        asPageContent(revision.content),
        tx,
      );

      // The address moves with the publish, in this transaction: `url` is set,
      // the old address redirects here and `draft_url` clears, then the one
      // version bump tells the site both the content and the address changed.
      // `applyDraftUrl` re-checks the address under the same lock, so a page
      // that took it after the save refuses the whole publish.
      const moved = applyingDraftUrl ? await applyDraftUrl(tx, page.id) : null;

      await tx`
        UPDATE cms_pages
        SET published_revision_id = ${revision.id}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${page.id}
      `;
      const contentVersion = await bumpContentVersion(tx);

      return {
        ok: true as const,
        revisionId: revision.id,
        contentVersion,
        changed: true,
        moved,
        warnings: guidance.warnings,
      };
    });
  } catch (error) {
    // The address was checked when it was saved, but another page may have taken
    // it since. The transaction rolled back whole, so nothing is applied; the
    // editor gets the same message a save gives.
    const message = await duplicateUrlMessage(error, page.draftUrl ?? page.url);
    if (message) {
      return {
        ok: false,
        reason: "duplicate",
        issue: { path: "url", message },
      };
    }
    throw error;
  }
};

export interface PageRevisionSummary {
  id: string;
  createdAt: Date;
  authorEmail: string | null;
  isPublished: boolean;
  isLatest: boolean;
  /** The draft: the newest revision and not the published one. See the slot's. */
  isDraft: boolean;
  /** When the revision this one restored was saved; null if not a restore. */
  restoredFromAt: Date | null;
  /**
   * One line of the revision's words — the page title and the first block's
   * first text field — so two same-day versions can be told apart. Empty when
   * the revision has no text field to show.
   */
  excerpt: string;
}

export const listPageHistory = async (
  page: PageRecord,
): Promise<PageRevisionSummary[]> => {
  const rows = (await db`
    SELECT r.id, r.created_at, r.content, i.email AS author_email,
      src.created_at AS restored_from_at
    FROM cms_revisions r
    LEFT JOIN cms_identities i ON i.id = r.created_by
    LEFT JOIN cms_revisions src ON src.id = r.restored_from
    WHERE r.target_type = 'page' AND r.target_id = ${page.id}
    ORDER BY r.created_at DESC, r.id DESC
  `) as {
    id: string;
    created_at: Date;
    content: Record<string, unknown>;
    author_email: string | null;
    restored_from_at: Date | null;
  }[];

  // The field metadata names the block's text fields, so the excerpt reads the
  // first *text* field rather than whichever value happens to be first (an
  // image id is a string too). One read for the whole list, not one per row.
  const blockTypes = new Map(
    (await listBlockTypes()).map((blockType) => [blockType.name, blockType]),
  );

  const firstBlockText = (content: Record<string, unknown>): string | null => {
    const [firstBlock] = asPageContent(content).blocks;
    if (!firstBlock) return null;
    const blockType = blockTypes.get(firstBlock.type);
    if (!blockType) return null;
    const { type: _type, ...fields } = firstBlock;
    return firstTextField(blockType.fields, fields);
  };

  return rows.map((row, index) => {
    const isPublished = row.id === page.publishedRevisionId;
    const isLatest = index === 0;
    return {
      id: row.id,
      createdAt: row.created_at,
      authorEmail: row.author_email,
      isPublished,
      isLatest,
      isDraft: isLatest && !isPublished,
      restoredFromAt: row.restored_from_at,
      excerpt: pageExcerpt(page.title, firstBlockText(row.content)),
    };
  });
};

export type RestorePageResult =
  | {
      ok: true;
      revision: RevisionRecord;
      /** The address change the restore dropped, for the editor's notice. */
      droppedUrl: string | null;
    }
  | { ok: false; reason: "not-found" };

export interface RestorePageInput {
  pageId: string;
  revisionId: string;
  page?: PageRecord;
  actorId: string | null;
}

/**
 * Restore an old page revision by copying it into a new draft.
 *
 * Restoring is the editor's way to discard a draft (there is no separate
 * discard action), so a pending address change goes with it: the revision and
 * `draft_url = NULL` are written in one transaction under the page's row lock.
 * Nothing live changes — the page keeps its address and redirects until
 * Publish.
 */
export const restorePageRevision = async (
  input: RestorePageInput,
): Promise<RestorePageResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const source = await getRevisionById(input.revisionId);
  if (source?.targetType !== "page" || source.targetId !== page.id) {
    return { ok: false, reason: "not-found" };
  }

  const restored = await db.begin(async (tx) => {
    const locked = (await tx`
      SELECT draft_url FROM cms_pages WHERE id = ${page.id} FOR UPDATE
    `) as { draft_url: string | null }[];
    if (locked.length === 0) {
      throw new Error(`Page ${page.id} not found`);
    }

    const revision = await createRevision(
      {
        targetType: "page",
        targetId: page.id,
        content: source.content,
        createdBy: input.actorId,
        restoredFrom: source.id,
      },
      tx,
    );

    await tx`UPDATE cms_pages SET draft_url = NULL WHERE id = ${page.id}`;
    return { revision, droppedUrl: locked[0].draft_url };
  });

  return { ok: true, ...restored };
};
