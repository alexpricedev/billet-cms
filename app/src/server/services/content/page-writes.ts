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
  type BlockTypeRecord,
  getPageTypeByName,
  listBlockTypes,
} from "./definitions";
import type { FieldIssue, RevisionConflict } from "./drafts";
import {
  asPageContent,
  findUnavailableBlocks,
  mergeUnavailableBlocks,
  type PageContent,
  validatePageContent,
} from "./page-content";
import {
  applyPageSettings,
  type FieldSettingIssue,
  getPageById,
  type PageRecord,
  type PageSettingsInput,
  type PageSettingsValues,
  resolveWritablePageType,
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

export type SavePageDraftResult =
  | { ok: true; revision: RevisionRecord }
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

  return { ok: true, revision: outcome.revision };
};

export type SavePageResult =
  | { ok: true; revision: RevisionRecord; page: PageRecord }
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

  const settings = validatePageSettings(input.settings);
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

  const outcome = await writePage(page, pageType, blockTypes, settings, input);

  if (outcome.kind === "duplicate") {
    return { ok: false, reason: "settings", issues: [outcome.issue] };
  }

  if (outcome.kind === "conflict") {
    return {
      ok: false,
      reason: "conflict",
      newer: await describeConflict(outcome.newer),
    };
  }

  return { ok: true, revision: outcome.revision, page: outcome.page };
};

type PageWriteOutcome =
  | { kind: "saved"; revision: RevisionRecord; page: PageRecord }
  | { kind: "conflict"; newer: RevisionRecord }
  | { kind: "duplicate"; issue: FieldSettingIssue };

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
    const duplicate = duplicatePageUrl(error);
    if (duplicate) return { kind: "duplicate", issue: duplicate };
    throw error;
  }
};

/** A unique violation on `cms_pages.url`, as an editor-facing issue. */
const duplicatePageUrl = (error: unknown): FieldSettingIssue | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { errno?: unknown }).errno;
  const constraint = (error as { constraint?: unknown }).constraint;
  if (code === "23505" && constraint === "cms_pages_url_idx") {
    return { path: "url", message: "Another page already uses this URL." };
  }
  return null;
};

export type PublishPageResult =
  | { ok: true; revisionId: string; contentVersion: number; changed: boolean }
  | { ok: false; reason: "no-draft" }
  | { ok: false; reason: "invalid"; issues: FieldIssue[] }
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

  return await db.begin(async (tx) => {
    const locked = (await tx`
      SELECT published_revision_id FROM cms_pages
      WHERE id = ${page.id} FOR UPDATE
    `) as { published_revision_id: string | null }[];
    if (locked.length === 0) throw new Error(`Page ${page.id} not found`);

    const revision = input.revisionId
      ? await getRevisionById(input.revisionId, tx)
      : await getLatestRevision("page", page.id, tx);

    if (revision?.targetType !== "page" || revision.targetId !== page.id) {
      return { ok: false as const, reason: "no-draft" as const };
    }

    if (input.requireLatest) {
      const latest = await getLatestRevision("page", page.id, tx);
      if (latest && latest.id !== revision.id) {
        return {
          ok: false as const,
          reason: "stale" as const,
          latestRevisionId: latest.id,
        };
      }
    }

    const validation = validatePageContent(
      pageType,
      blockTypes,
      asPageContent(revision.content),
      { allowNotAllowedBlocks: true },
    );
    if (!validation.ok) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        issues: validation.issues,
      };
    }

    if (locked[0].published_revision_id === revision.id) {
      return {
        ok: true as const,
        revisionId: revision.id,
        contentVersion: await readContentVersion(tx),
        changed: false,
      };
    }

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
    };
  });
};

export interface PageRevisionSummary {
  id: string;
  createdAt: Date;
  authorEmail: string | null;
  isPublished: boolean;
  isLatest: boolean;
}

export const listPageHistory = async (
  page: PageRecord,
): Promise<PageRevisionSummary[]> => {
  const rows = (await db`
    SELECT r.id, r.created_at, i.email AS author_email
    FROM cms_revisions r
    LEFT JOIN cms_identities i ON i.id = r.created_by
    WHERE r.target_type = 'page' AND r.target_id = ${page.id}
    ORDER BY r.created_at DESC, r.id DESC
  `) as { id: string; created_at: Date; author_email: string | null }[];

  return rows.map((row, index) => ({
    id: row.id,
    createdAt: row.created_at,
    authorEmail: row.author_email,
    isPublished: row.id === page.publishedRevisionId,
    isLatest: index === 0,
  }));
};

export type RestorePageResult =
  | { ok: true; revision: RevisionRecord }
  | { ok: false; reason: "not-found" };

export interface RestorePageInput {
  pageId: string;
  revisionId: string;
  page?: PageRecord;
  actorId: string | null;
}

/** Restore an old page revision by copying it into a new draft. */
export const restorePageRevision = async (
  input: RestorePageInput,
): Promise<RestorePageResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const source = await getRevisionById(input.revisionId);
  if (source?.targetType !== "page" || source.targetId !== page.id) {
    return { ok: false, reason: "not-found" };
  }

  const revision = await createRevision({
    targetType: "page",
    targetId: page.id,
    content: source.content,
    createdBy: input.actorId,
  });

  return { ok: true, revision };
};
