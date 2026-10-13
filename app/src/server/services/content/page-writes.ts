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
import { type BlockTypeRecord, getPageTypeByName } from "./definitions";
import type { FieldIssue, RevisionConflict } from "./drafts";
import {
  asPageContent,
  findUnavailableBlocks,
  type PageContent,
  validatePageContent,
} from "./page-content";
import { getPageById, type PageRecord } from "./pages";
import { bumpContentVersion, readContentVersion } from "./publishing";
import {
  createRevision,
  getLatestRevision,
  getRevisionById,
  type RevisionRecord,
} from "./revisions";

/** All published block types, keyed by name, for one page's validation. */
const loadBlockTypes = async (
  sql: SQL,
): Promise<Map<string, BlockTypeRecord>> => {
  const rows = (await sql`
    SELECT id, name, json_schema, fields, schema_hash, removed_at
    FROM cms_block_types
  `) as {
    id: string;
    name: string;
    json_schema: Record<string, unknown>;
    fields: BlockTypeRecord["fields"];
    schema_hash: string;
    removed_at: Date | null;
  }[];

  return new Map(
    rows.map((row) => [
      row.name,
      {
        id: row.id,
        name: row.name,
        jsonSchema: row.json_schema,
        fields: row.fields,
        schemaHash: row.schema_hash,
        removedAt: row.removed_at,
      },
    ]),
  );
};

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
 * left out, leaving everything the client did send to validation. A removed
 * block is flagged in the form and refuses to publish, but its data is never
 * silently lost.
 */
const carryUnavailableBlocks = async (
  page: PageRecord,
  pageType: Awaited<ReturnType<typeof pageTypeForWrite>>,
  blockTypes: Map<string, BlockTypeRecord>,
  submitted: PageContent,
  baseRevisionId: string | null,
  sql: SQL,
): Promise<PageContent> => {
  if (!baseRevisionId) return submitted;

  const base = await getRevisionById(baseRevisionId, sql);
  if (base?.targetType !== "page" || base.targetId !== page.id)
    return submitted;

  const baseBlocks = asPageContent(base.content).blocks;
  const unavailable = findUnavailableBlocks(pageType, baseBlocks, blockTypes);
  const missing = unavailable
    .map((entry) => baseBlocks[entry.index])
    .filter((block) => !submitted.blocks.some((b) => b.type === block.type));

  if (missing.length === 0) return submitted;
  return { blocks: [...submitted.blocks, ...missing] };
};

/**
 * Save a page draft.
 *
 * A block whose type a deploy removed is carried through untouched (Q4): a save
 * must not delete content because the code stopped describing it. Everything
 * else is validated against the page type, so a draft is one the page type
 * accepts before it is ever published.
 */
export const savePageDraft = async (
  input: SavePageDraftInput,
): Promise<SavePageDraftResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const pageType = await pageTypeForWrite(page);
  const blockTypes = await loadBlockTypes(db);

  const validation = validatePageContent(pageType, blockTypes, input.content, {
    allowUnavailableBlocks: true,
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
 * the editor is asked to remove the block first. The same refusals slots get
 * apply — no draft, a no-longer-valid draft, a newer draft than the one named.
 */
export const publishPage = async (
  input: PublishPageInput,
): Promise<PublishPageResult> => {
  const page = input.page ?? (await getPageById(input.pageId));
  if (!page) throw new Error(`Page ${input.pageId} not found`);

  const pageType = await pageTypeForWrite(page);
  const blockTypes = await loadBlockTypes(db);

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
