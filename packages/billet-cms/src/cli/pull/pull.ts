/**
 * `cms:pull`: replace local `cms_` content with a CMS's published export.
 *
 * A local or preview environment gets production content without database
 * credentials: an admin creates an export token in the CMS, and this command
 * fetches `GET /export` with it and writes the result into the local database.
 * It is deliberately **one-way** — nothing is ever pushed back — and it
 * **refuses to run under `NODE_ENV=production`**, because overwriting a live
 * site's content from another CMS is never what an operator meant.
 *
 * What it replaces: published pages, slots, their published revisions, redirects
 * and media rows. Because it deletes every local `cms_revisions` row before it
 * inserts, it **discards local drafts** too: anything not published on the
 * source CMS is gone from this database after a pull, and the export document
 * itself carries no draft. What it never touches: local block/page type
 * definitions (they come from the local deploy), users, sessions and tokens.
 * Images keep the production bucket's URLs, so the local site serves production
 * images without copying a byte.
 *
 * The whole write is one transaction: a pull that fails part-way leaves the
 * local content as it was rather than a half-replaced site.
 */
import type { SQL } from "bun";
import { asCmsExport, type CmsExport, CONTRACT_VERSION } from "../../contract";

/** Refused because the command is destructive and production is not the target. */
export class PullRefusedError extends Error {
  constructor() {
    super(
      "cms:pull refuses to run with NODE_ENV=production. It replaces local cms_ " +
        "content with another CMS's, which is never right on a live site. Run " +
        "it in development or preview.",
    );
    this.name = "PullRefusedError";
  }
}

/** The remote answered with something that isn't an export document. */
export class ExportDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportDocumentError";
  }
}

export interface PullSummary {
  pages: number;
  slots: number;
  revisions: number;
  redirects: number;
  media: number;
  /** The local `cms_meta.content_version` after the pull. */
  contentVersion: number;
}

export interface PullOptions {
  /** The CMS origin, e.g. `https://cms.example.com`. */
  from: string;
  /** The raw export token. */
  token: string;
  /** The local database. */
  sql: SQL;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The local database's `cms_meta.contract_version`, or `""` when the row is
 * missing (the local CMS has not migrated).
 */
const readLocalContractVersion = async (sql: SQL): Promise<string> => {
  const rows = (await sql`
    SELECT contract_version FROM cms_meta WHERE id = 1
  `) as { contract_version: string }[];
  return rows.length > 0 ? rows[0].contract_version : "";
};

/**
 * Refuse the write unless the local database speaks this plugin's contract.
 *
 * Checked inside the transaction, before the first DELETE, so a mismatched
 * database keeps every row it had. The source document is checked separately in
 * `pullFrom`; this is the other end of the same handshake.
 */
const assertLocalContractVersion = async (sql: SQL): Promise<void> => {
  const local = await readLocalContractVersion(sql);
  if (local !== CONTRACT_VERSION) {
    throw new ExportDocumentError(
      `This database's cms_meta speaks ${
        local || "no contract version"
      }, but this plugin speaks ${CONTRACT_VERSION}. Run the CMS migrations ` +
        "and publish this site, then pull again.",
    );
  }
};

/** Bump the local content version so the local site's cache drops. */
const bumpContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql`
    UPDATE cms_meta
    SET content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    RETURNING content_version
  `) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

/**
 * Replace local content with the export, in one transaction.
 *
 * Children before parents on the way in and the reverse on the way out: the
 * deletes go redirects → pages/slots → revisions → media so no foreign key is
 * violated, and the inserts go media/revisions → pages/slots → redirects.
 */
export const applyExport = async (
  sql: SQL,
  document: CmsExport,
): Promise<PullSummary> => {
  return await sql.begin(async (tx) => {
    // First statement in the transaction: a database on another contract never
    // reaches the deletes.
    await assertLocalContractVersion(tx);

    await tx`DELETE FROM cms_redirects`;
    await tx`DELETE FROM cms_pages`;
    await tx`DELETE FROM cms_slots`;
    await tx`DELETE FROM cms_revisions`;
    await tx`DELETE FROM cms_media`;

    for (const media of document.media) {
      await tx`
        INSERT INTO cms_media
          (id, object_key, content_type, byte_size, width, height, alt,
           focal_x, focal_y, variants, created_at, updated_at)
        VALUES (
          ${media.id}, ${media.objectKey}, ${media.contentType},
          ${media.byteSize}, ${media.width}, ${media.height}, ${media.alt},
          ${media.focalX}, ${media.focalY}, ${media.variants},
          ${new Date(media.createdAt)}, ${new Date(media.updatedAt)}
        )
      `;
    }

    for (const revision of document.revisions) {
      await tx`
        INSERT INTO cms_revisions
          (id, target_type, target_id, content, created_by, created_at)
        VALUES (
          ${revision.id}, ${revision.targetType}, ${revision.targetId},
          ${revision.content}, ${revision.createdBy},
          ${new Date(revision.createdAt)}
        )
      `;
    }

    for (const page of document.pages) {
      await tx`
        INSERT INTO cms_pages
          (id, page_type, url, title, seo_description, social_image,
           published_revision_id, created_at, updated_at)
        VALUES (
          ${page.id}, ${page.pageType}, ${page.url}, ${page.title},
          ${page.seoDescription}, ${page.socialImage}, ${page.publishedRevisionId},
          ${new Date(page.createdAt)}, ${new Date(page.updatedAt)}
        )
      `;
    }

    for (const slot of document.slots) {
      await tx`
        INSERT INTO cms_slots
          (id, name, block_name, page, preview_path, label, help,
           published_revision_id, created_at, updated_at)
        VALUES (
          ${slot.id}, ${slot.name}, ${slot.blockName}, ${slot.page},
          ${slot.previewPath}, ${slot.label}, ${slot.help},
          ${slot.publishedRevisionId}, ${new Date(slot.createdAt)},
          ${new Date(slot.updatedAt)}
        )
      `;
    }

    for (const redirect of document.redirects) {
      await tx`
        INSERT INTO cms_redirects (id, from_path, to_page_id, created_at)
        VALUES (
          ${redirect.id}, ${redirect.fromPath}, ${redirect.toPageId},
          ${new Date(redirect.createdAt)}
        )
      `;
    }

    return {
      pages: document.pages.length,
      slots: document.slots.length,
      revisions: document.revisions.length,
      redirects: document.redirects.length,
      media: document.media.length,
      contentVersion: await bumpContentVersion(tx),
    };
  });
};

/**
 * The origin to call, from `--from`.
 *
 * Parsed with `new URL` rather than string-trimmed, so a typo fails here with a
 * clear message instead of somewhere in `fetch`, and `url.origin` drops any
 * path, query or fragment someone pasted alongside the host. `http` is allowed
 * only for `localhost` (and its loopback spellings), because an export carries
 * the whole published site and a bearer token across the network: anything but
 * TLS would hand both to whoever is on the path.
 */
const parseOrigin = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ExportDocumentError("A CMS URL is required (--from <url>).");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ExportDocumentError(
      `--from must be a full URL, for example https://cms.example.com (got "${raw}").`,
    );
  }

  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const httpAllowed = url.protocol === "http:" && loopback.has(url.hostname);
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new ExportDocumentError(
      `--from must be https (got "${raw}"). Plain http is allowed only for localhost.`,
    );
  }

  return url.origin;
};

/**
 * Fetch an export and replace local content with it.
 *
 * The contract version is checked before anything is written: a document from a
 * CMS that speaks another version may have a shape this code cannot write, and
 * refusing is far better than a partial import. An empty version is refused for
 * the same reason — a document that does not say which contract it speaks
 * cannot be trusted to be this one. A wrong URL, an HTML error page or a 401 all
 * become a clear message naming what came back.
 */
export const pullFrom = async (options: PullOptions): Promise<PullSummary> => {
  if (process.env.NODE_ENV === "production") {
    throw new PullRefusedError();
  }

  const base = parseOrigin(options.from);
  const url = `${base}/export`;
  const doFetch = options.fetchImpl ?? fetch;

  const response = await doFetch(url, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new ExportDocumentError(
      `The CMS at ${url} answered ${response.status} ${response.statusText}. ` +
        "Check the token and that the CMS is running.",
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ExportDocumentError(
      `The CMS at ${url} did not return JSON — check the URL points at the CMS.`,
    );
  }

  const document = asCmsExport(value);
  if (!document) {
    throw new ExportDocumentError(
      `The response from ${url} is not a billet-cms export document.`,
    );
  }

  if (document.contractVersion !== CONTRACT_VERSION) {
    throw new ExportDocumentError(
      document.contractVersion
        ? `Contract version mismatch: the CMS speaks ${document.contractVersion}, ` +
            `but this plugin speaks ${CONTRACT_VERSION}. Upgrade whichever is ` +
            "behind, then pull again."
        : `The export from ${url} does not name a contract version, so it cannot ` +
            `be trusted to speak this plugin's ${CONTRACT_VERSION}. Check the CMS ` +
            "has migrated, then pull again.",
    );
  }

  return applyExport(options.sql, document);
};
