/**
 * Building the export document.
 *
 * `GET /export` answers with everything a local or preview environment needs to
 * serve the same published site, and nothing it shouldn't have: published pages
 * and slots, the revisions those point at, redirects and media rows. Drafts,
 * users, sessions, tokens and definitions are never selected, so the query set
 * here is also the scope guarantee — there is no flag to widen it.
 *
 * The five reads run in one read-only, `REPEATABLE READ` transaction, so the
 * document is a single snapshot: a publish landing mid-read cannot put a page
 * from before it beside a revision from after, and a `cms:pull` applies a
 * consistent set rather than one the next pull has to repair. `READ ONLY` is a
 * guardrail — export never writes — and `REPEATABLE READ` is the least isolation
 * that gives one stable snapshot, without `SERIALIZABLE`'s serialization
 * failures. The reads are ordered (pages by URL, slots by page then name,
 * revisions by id, redirects by path, media by creation) so two exports of the
 * same content are identical apart from `exportedAt`.
 */

import {
  type CmsExport,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportedMedia,
  type ExportedPage,
  type ExportedRedirect,
  type ExportedRevision,
  type ExportedSlot,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import type { SQL, TransactionSQL } from "bun";
import { db } from "../database";
import { log } from "../logger";

/** Turn a driver date (or a string) into the ISO-8601 the document carries. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

interface PageRow {
  id: string;
  page_type: string;
  url: string;
  title: string;
  seo_description: string | null;
  social_image: string | null;
  published_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SlotRow {
  id: string;
  name: string;
  block_name: string;
  page: string;
  preview_path: string;
  label: string | null;
  help: string | null;
  published_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RevisionRow {
  id: string;
  target_type: "page" | "slot";
  target_id: string;
  content: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
}

interface RedirectRow {
  id: string;
  from_path: string;
  to_page_id: string;
  created_at: Date;
}

interface MediaRow {
  id: string;
  object_key: string;
  content_type: string;
  byte_size: number | string;
  width: number;
  height: number;
  alt: string;
  focal_x: number;
  focal_y: number;
  variants: unknown;
  created_at: Date;
  updated_at: Date;
}

const toPage = (row: PageRow): ExportedPage => ({
  id: row.id,
  pageType: row.page_type,
  url: row.url,
  title: row.title,
  seoDescription: row.seo_description,
  socialImage: row.social_image,
  publishedRevisionId: row.published_revision_id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toSlot = (row: SlotRow): ExportedSlot => ({
  id: row.id,
  name: row.name,
  blockName: row.block_name,
  page: row.page,
  previewPath: row.preview_path,
  label: row.label,
  help: row.help,
  publishedRevisionId: row.published_revision_id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toRevision = (row: RevisionRow): ExportedRevision => ({
  id: row.id,
  targetType: row.target_type,
  targetId: row.target_id,
  content: row.content,
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
});

const toRedirect = (row: RedirectRow): ExportedRedirect => ({
  id: row.id,
  fromPath: row.from_path,
  toPageId: row.to_page_id,
  createdAt: iso(row.created_at),
});

const toMedia = (row: MediaRow): ExportedMedia => ({
  id: row.id,
  objectKey: row.object_key,
  contentType: row.content_type,
  byteSize: Number(row.byte_size),
  width: row.width,
  height: row.height,
  alt: row.alt,
  focalX: row.focal_x,
  focalY: row.focal_y,
  variants: Array.isArray(row.variants) ? (row.variants as MediaVariant[]) : [],
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/**
 * Read `cms_meta`, tolerating a database the CMS hasn't migrated yet.
 *
 * A missing row or an unreadable table leaves the document with an empty
 * contract version, which `cms:pull` refuses — so the failure is never silent.
 * It is logged here so an operator can see *why* the pull refused, rather than
 * chasing a mismatch that isn't one.
 *
 * The read is wrapped in a savepoint: it runs inside the export's transaction,
 * and a failed query would otherwise abort that whole transaction and take the
 * following reads with it. A savepoint rolls the failure back on its own.
 */
const readMeta = async (
  sql: TransactionSQL,
): Promise<{ contractVersion: string; contentVersion: number }> => {
  try {
    return await sql.savepoint(async (sp) => {
      const rows = (await sp`
        SELECT contract_version, content_version FROM cms_meta WHERE id = 1
      `) as { contract_version: string; content_version: string | number }[];
      if (rows.length === 0) {
        log.warn(
          "export",
          "cms_meta has no row with id = 1; the export carries no contract version and a pull will refuse it.",
        );
        return { contractVersion: "", contentVersion: 0 };
      }
      return {
        contractVersion: rows[0].contract_version,
        contentVersion: Number(rows[0].content_version),
      };
    });
  } catch (error) {
    log.error(
      "export",
      `Could not read cms_meta (${
        error instanceof Error ? error.message : String(error)
      }); the export carries no contract version and a pull will refuse it.`,
    );
    return { contractVersion: "", contentVersion: 0 };
  }
};

/**
 * Build the export document.
 *
 * Only pages and slots with a published revision are carried, and only the
 * revisions they point at: a slot declared but never published has nothing to
 * send, and a draft revision is deliberately absent. Media is the whole
 * library, because an image referenced by published content must be readable
 * and the library is small.
 */
export const buildExport = async (sql: SQL = db): Promise<CmsExport> =>
  // One read-only, REPEATABLE READ transaction spanning every read, so the
  // document is a single snapshot (see the module comment). `tx` is what every
  // query below runs on; `sql` is only the handle the transaction is begun on.
  await sql.begin("isolation level repeatable read read only", async (tx) => {
    const meta = await readMeta(tx);

    const pageRows = (await tx`
      SELECT id, page_type, url, title, seo_description, social_image,
             published_revision_id, created_at, updated_at
      FROM cms_pages
      WHERE published_revision_id IS NOT NULL
      ORDER BY url
    `) as PageRow[];

    const slotRows = (await tx`
      SELECT id, name, block_name, page, preview_path, label, help,
             published_revision_id, created_at, updated_at
      FROM cms_slots
      WHERE published_revision_id IS NOT NULL
      ORDER BY page, name
    `) as SlotRow[];

    // The published revisions of both pages and slots, in one read. Drafts
    // belong to neither set, so they are structurally absent. An `IN` over the
    // two pointers selects each revision row once without the full-row UNION the
    // join version paid for. The `id` order makes the array deterministic:
    // without it Postgres is free to return the rows in any order, and two
    // exports of the same content would diff.
    const revisionRows = (await tx`
      SELECT r.id, r.target_type, r.target_id, r.content, r.created_by,
             r.created_at
      FROM cms_revisions r
      WHERE r.id IN (
        SELECT published_revision_id FROM cms_pages
        WHERE published_revision_id IS NOT NULL
        UNION
        SELECT published_revision_id FROM cms_slots
        WHERE published_revision_id IS NOT NULL
      )
      ORDER BY r.id
    `) as RevisionRow[];

    const redirectRows = (await tx`
      SELECT id, from_path, to_page_id, created_at
      FROM cms_redirects
      ORDER BY from_path
    `) as RedirectRow[];

    const mediaRows = (await tx`
      SELECT id, object_key, content_type, byte_size, width, height, alt,
             focal_x, focal_y, variants, created_at, updated_at
      FROM cms_media
      ORDER BY created_at, id
    `) as MediaRow[];

    log.info(
      "export",
      `Export document built: ${pageRows.length} pages, ${slotRows.length} slots, ${mediaRows.length} media`,
    );

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      contractVersion: meta.contractVersion,
      contentVersion: meta.contentVersion,
      exportedAt: new Date().toISOString(),
      pages: pageRows.map(toPage),
      slots: slotRows.map(toSlot),
      revisions: revisionRows.map(toRevision),
      redirects: redirectRows.map(toRedirect),
      media: mediaRows.map(toMedia),
    };
  });
