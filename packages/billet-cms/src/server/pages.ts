/**
 * Reading and serving the pages an editor created, for the site.
 *
 * A page is a URL, a title and some SEO settings around a list of validated
 * blocks. The site renders its own markup — the plugin never imports a site's
 * block code — so this module answers two questions and leaves the markup to the
 * caller:
 *
 *   1. **Where does this path go?** `getRedirect` answers with the current URL of
 *      the page a `cms_redirects` row points at, which is what makes a rename a
 *      working 301 and keeps a link stored by page id alive.
 *   2. **What is on this path?** `getPage` returns the published page, its
 *      blocks validated against the block types the site published.
 *
 * `createCmsPageRoute` is the catch-all a site mounts in its own fallback, just
 * before its 404: redirect first, then page, then `null` so the site's 404 runs.
 * App routes always win because the handler is only reached for a path no route
 * claimed.
 *
 * Reads are cached per process and invalidated on `cms_meta.content_version`
 * (Q3), the same cache the slot reader uses, so a publish shows within a second.
 * A removed block, an unpublished page or a missing CMS table is a skip and a
 * log, never a 500 on a public page.
 */
import type { SQL } from "bun";
import { TABLES } from "../contract";
import type { LinkValue } from "../fields/field";
import { validateContent } from "../schema";
import { ContentCache } from "./cache";
import { defaultSkipLogger, type SkipLogger } from "./log";

/** One block of a page's content: its fields plus the `type` discriminator. */
export interface CmsPageBlock {
  type: string;
  [key: string]: unknown;
}

/** A published page, ready for the site's own render function. */
export interface CmsPage {
  id: string;
  /** The canonical path, e.g. `/about`. */
  url: string;
  title: string;
  seoDescription: string | null;
  socialImage: string | null;
  pageType: string;
  blocks: CmsPageBlock[];
  /** When the page row last changed, for a sitemap `lastmod`. */
  lastModified: Date;
}

/** One entry the site merges into its own `sitemap.xml`. */
export interface CmsSitemapEntry {
  url: string;
  lastModified: Date;
}

export interface CmsPagesOptions {
  /** The site's pool, shared with its own Billet tables. */
  sql: SQL;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often `content_version` is re-read. Defaults to one second (Q3). */
  versionPollMs?: number;
  /** Where skipped content is reported. Defaults to the console. */
  onSkip?: SkipLogger;
}

export interface CmsPagesReader {
  /** The published page at `path`, or `null` when there is none. */
  getPage(path: string): Promise<CmsPage | null>;
  /** The current URL a redirect at `path` points at, or `null`. */
  getRedirect(path: string): Promise<string | null>;
  /** The href a stored link resolves to, or `null` when its page is gone. */
  resolveLink(link: LinkValue): Promise<string | null>;
  /** The published pages a site merges into its sitemap, in URL order. */
  listSitemapEntries(): Promise<CmsSitemapEntry[]>;
  /** Drop the cache and force the next read to re-check `content_version`. */
  invalidate(): void;
}

interface PageRow {
  id: string;
  page_type: string;
  url: string;
  title: string;
  seo_description: string | null;
  social_image: string | null;
  published_revision_id: string | null;
  updated_at: Date;
}

interface BlockTypeRow {
  name: string;
  json_schema: Record<string, unknown>;
  removed_at: Date | null;
}

/** Trailing slashes are stripped before a lookup; `/` stays as it is. */
const canonicalPath = (path: string): string => {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
};

const readContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql.unsafe(
    `SELECT content_version FROM ${TABLES.meta} WHERE id = 1`,
  )) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Build a page reader, cached per pool.
 *
 * `getPage`, `getRedirect` and `resolveLink` share one cache keyed per query
 * (`page:`, `redirect:`, `link:`), so the version is read once a second no
 * matter which of them a page used.
 */
export const createCmsPages = (options: CmsPagesOptions): CmsPagesReader => {
  const { sql } = options;
  const onSkip = options.onSkip ?? defaultSkipLogger;

  const loadPage = async (path: string): Promise<CmsPage | null> => {
    const pages = (await sql.unsafe(
      `SELECT id, page_type, url, title, seo_description, social_image,
              published_revision_id, updated_at
       FROM ${TABLES.pages} WHERE url = $1`,
      [path],
    )) as PageRow[];

    const page = pages[0];
    // Never published: nothing to render, and nothing wrong.
    if (!page?.published_revision_id) return null;

    const revisions = (await sql.unsafe(
      `SELECT content FROM ${TABLES.revisions} WHERE id = $1`,
      [page.published_revision_id],
    )) as { content: Record<string, unknown> }[];
    const revision = revisions[0];
    if (!revision) {
      onSkip(
        `page "${path}" points at a published revision that no longer exists`,
      );
      return null;
    }

    const blockTypes = (await sql.unsafe(
      `SELECT name, json_schema, removed_at FROM ${TABLES.blockTypes}`,
    )) as BlockTypeRow[];
    const byName = new Map(blockTypes.map((row) => [row.name, row]));

    const blocks = Array.isArray(revision.content.blocks)
      ? revision.content.blocks
      : [];
    const rendered: CmsPageBlock[] = [];

    for (const raw of blocks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        onSkip(`page "${path}" has a block that isn't an object`);
        continue;
      }
      const block = raw as Record<string, unknown>;
      const type = block.type;
      if (typeof type !== "string") {
        onSkip(`page "${path}" has a block with no type`);
        continue;
      }

      const blockType = byName.get(type);
      if (!blockType) {
        onSkip(`page "${path}" uses block "${type}", which is not published`);
        continue;
      }
      if (blockType.removed_at !== null) {
        onSkip(
          `page "${path}" uses block "${type}", which was removed by a deploy`,
        );
        continue;
      }

      const { type: _type, ...fields } = block;
      // Removed fields are tolerated (Q4): a field a deploy dropped stays in the
      // stored content and must not fail the whole block.
      const validation = validateContent(blockType.json_schema, fields, {
        allowAdditionalFields: true,
      });
      if (!validation.success) {
        const detail = validation.issues
          .map(
            (issue) =>
              `${issue.path.join(".") || "(content)"}: ${issue.message}`,
          )
          .join("; ");
        onSkip(
          `page "${path}" block "${type}" no longer validates — ${detail}`,
        );
        continue;
      }

      rendered.push({ type, ...(validation.data as Record<string, unknown>) });
    }

    return {
      id: page.id,
      url: page.url,
      title: page.title,
      seoDescription: page.seo_description,
      socialImage: page.social_image,
      pageType: page.page_type,
      blocks: rendered,
      lastModified: page.updated_at,
    };
  };

  const loadRedirect = async (path: string): Promise<string | null> => {
    const rows = (await sql.unsafe(
      `SELECT p.url AS url
       FROM ${TABLES.redirects} r
       JOIN ${TABLES.pages} p ON p.id = r.to_page_id
       WHERE r.from_path = $1`,
      [path],
    )) as { url: string }[];
    return rows[0]?.url ?? null;
  };

  const loadLink = async (pageId: string): Promise<string | null> => {
    const rows = (await sql.unsafe(
      `SELECT url FROM ${TABLES.pages} WHERE id = $1`,
      [pageId],
    )) as { url: string }[];
    return rows[0]?.url ?? null;
  };

  // One loader dispatching on the key's prefix: `ContentCache` caches one value
  // per key but has a single `load`, so the key is what tells it which query to
  // run on a miss.
  const loadByKey = async (key: string): Promise<unknown> => {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const rest = key.slice(separator + 1);
    if (kind === "page") return await loadPage(rest);
    if (kind === "redirect") return await loadRedirect(rest);
    if (kind === "link") return await loadLink(rest);
    return null;
  };

  const cache = new ContentCache<unknown>({
    readVersion: () => readContentVersion(sql),
    load: loadByKey,
    onVersionError: (error) => {
      onSkip(`could not check the CMS content version: ${describe(error)}`);
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.versionPollMs !== undefined
      ? { intervalMs: options.versionPollMs }
      : {}),
  });

  return {
    async getPage(path: string): Promise<CmsPage | null> {
      const canonical = canonicalPath(path);
      try {
        return (await cache.get(`page:${canonical}`)) as CmsPage | null;
      } catch (error) {
        onSkip(`could not read page "${canonical}": ${describe(error)}`);
        return null;
      }
    },

    async getRedirect(path: string): Promise<string | null> {
      const canonical = canonicalPath(path);
      try {
        return (await cache.get(`redirect:${canonical}`)) as string | null;
      } catch (error) {
        onSkip(`could not read redirect "${canonical}": ${describe(error)}`);
        return null;
      }
    },

    async resolveLink(link: LinkValue): Promise<string | null> {
      if (link.type === "url") return link.url;
      try {
        return (await cache.get(`link:${link.pageId}`)) as string | null;
      } catch (error) {
        onSkip(
          `could not resolve a link to page "${link.pageId}": ${describe(error)}`,
        );
        return null;
      }
    },

    async listSitemapEntries(): Promise<CmsSitemapEntry[]> {
      try {
        const rows = (await sql.unsafe(
          `SELECT url, updated_at FROM ${TABLES.pages}
           WHERE published_revision_id IS NOT NULL
           ORDER BY url`,
        )) as { url: string; updated_at: Date }[];
        return rows.map((row) => ({
          url: row.url,
          lastModified: row.updated_at,
        }));
      } catch (error) {
        onSkip(`could not read the CMS sitemap: ${describe(error)}`);
        return [];
      }
    },

    invalidate(): void {
      cache.invalidate();
    },
  };
};

export interface CmsPageRouteOptions extends CmsPagesOptions {
  /**
   * Render a resolved page to a Response. The site owns the layout and the block
   * render functions; the plugin owns the redirect/page/404 decision around it.
   */
  render: (page: CmsPage) => Response | Promise<Response>;
}

/**
 * The catch-all a site mounts in its fallback, just before its 404.
 *
 * Order is the spec's: a redirect answers first (a 301 to the page's current
 * URL, query string preserved), then a published page is rendered, then `null`
 * so the site's own `render404` runs. A non-GET/HEAD request is left to the site
 * — the CMS serves pages, not form posts.
 */
export const createCmsPageRoute = (
  options: CmsPageRouteOptions,
): ((req: Request) => Promise<Response | null>) => {
  const reader = createCmsPages(options);

  return async (req: Request): Promise<Response | null> => {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;

    const url = new URL(req.url);

    const redirected = await reader.getRedirect(url.pathname);
    if (redirected !== null) {
      return new Response("", {
        status: 301,
        headers: { Location: `${redirected}${url.search}` },
      });
    }

    const page = await reader.getPage(url.pathname);
    if (page) return await options.render(page);

    return null;
  };
};

/**
 * Readers, one per pool, keyed the way the slot reader is.
 *
 * A convenience for a site rendering a page in its own route rather than
 * mounting the catch-all.
 */
const readers = new WeakMap<SQL, CmsPagesReader>();

export const getCmsPagesReader = (sql: SQL): CmsPagesReader => {
  const existing = readers.get(sql);
  if (existing) return existing;
  const reader = createCmsPages({ sql });
  readers.set(sql, reader);
  return reader;
};

/** The published page at `path`, using a process-wide reader for `sql`. */
export const getPage = (sql: SQL, path: string): Promise<CmsPage | null> =>
  getCmsPagesReader(sql).getPage(path);

/** The published pages a site merges into its sitemap. */
export const listSitemapEntries = (sql: SQL): Promise<CmsSitemapEntry[]> =>
  getCmsPagesReader(sql).listSitemapEntries();
