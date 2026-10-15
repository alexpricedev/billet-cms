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
 * before its 404: redirect first (the query string rides along, so a preview
 * token survives a 301 — review round 3, Q2), then a valid preview reads the
 * draft, then the published page, then `null` so the site's 404 runs. App routes
 * always win because the handler is only reached for a path no route claimed.
 *
 * Reads are cached per process and invalidated on `cms_meta.content_version`
 * (Q3), the same cache the slot reader uses, so a publish shows within a second.
 * The routes a path can take — every published page's URL and every redirect —
 * are loaded as one table and cached under one key, so a 404 runs no per-path
 * query and adds no per-path cache entry (review round 1). A removed block, an
 * unpublished page or a missing CMS table is a skip and a log, never a 500 on a
 * public page.
 *
 * A valid preview token (`./preview`, Phase 6) is the one thing that leaves that
 * cache: `getPage(path, { preview })` reads the draft directly, and the catch-all
 * wraps the rendered page in the banner and the no-cache headers.
 */
import type { SQL } from "bun";
import { TABLES } from "../contract";
import type { LinkValue } from "../fields/field";
import { sameOriginPath } from "../fields/path";
import type { PreviewAccess } from "../preview";
import { applyPreview, getPreviewAccess } from "../preview";
import { validateContent } from "../schema";
import { CONTENT_VERSION_POLL_MS, ContentCache } from "./cache";
import { defaultSkipLogger, type SkipLogger } from "./log";
import { latestRevisionId } from "./revisions";

// Re-exported for the sites and tests that imported it from here before it
// moved to the field vocabulary (`../fields/path`), where `slot()` can also
// apply the same rule to a declared `previewPath`.
export { sameOriginPath };

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
  /**
   * The published page at `path`, or `null` when there is none.
   *
   * Pass `{ preview }` with valid preview access to read the *draft* the token
   * covers; `null` is the published read, so a caller can forward the access a
   * request carried without branching. The read bypasses the content-version
   * cache entirely (a preview must never be served from, or written to, the
   * published cache), and only the page the token names as its subject uses its
   * newest revision — any other page still reads as published.
   */
  getPage(
    path: string,
    options?: { preview?: PreviewAccess | null },
  ): Promise<CmsPage | null>;
  /** The current URL a redirect at `path` points at, or `null`. */
  getRedirect(path: string): Promise<string | null>;
  /** The href a stored link resolves to, or `null` when its page is gone. */
  resolveLink(link: LinkValue): Promise<string | null>;
  /** The published pages a site merges into its sitemap, in URL order. */
  listSitemapEntries(): Promise<CmsSitemapEntry[]>;
  /**
   * A hard reset: drop every cached entry and re-read `content_version` on the
   * next read.
   */
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

// The columns both page reads select. Shared so the published read and the
// preview read cannot drift into selecting different fields.
const PAGE_COLUMNS = `id, page_type, url, title, seo_description, social_image,
              published_revision_id, updated_at`;

interface BlockTypeRow {
  name: string;
  json_schema: Record<string, unknown>;
  removed_at: Date | null;
}

/**
 * Every route a request can take, in one read.
 *
 * `byUrl` answers "what page is at this path?" and `redirects` answers "where
 * did this path move to?". Both are built from the *published* pages only
 * (review round 1): a draft is not served and a redirect to it resolves to
 * nothing, so a page becomes live when it is published and not before.
 */
interface RouteTable {
  /** Published path to page id. */
  byUrl: Map<string, string>;
  /** Page id to its published path, for resolving a stored link. */
  byId: Map<string, string>;
  /** Old path to the current path of its *published* target page. */
  redirects: Map<string, string>;
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
 * Read every published page's URL and every redirect into one table.
 *
 * Loading the whole table once — rather than looking a path up as it arrives —
 * is what keeps the catch-all cheap: the table has one cache entry, and a path
 * that matches nothing (a 404) is a lookup that misses rather than a query and
 * a cache entry keyed by the missing path.
 */
const loadRoutes = async (sql: SQL): Promise<RouteTable> => {
  const pages = (await sql.unsafe(
    `SELECT id, url FROM ${TABLES.pages} WHERE published_revision_id IS NOT NULL`,
  )) as { id: string; url: string }[];

  const byUrl = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const page of pages) {
    byUrl.set(page.url, page.id);
    byId.set(page.id, page.url);
  }

  const rows = (await sql.unsafe(
    `SELECT from_path, to_page_id FROM ${TABLES.redirects}`,
  )) as { from_path: string; to_page_id: string }[];

  const redirects = new Map<string, string>();
  for (const row of rows) {
    // A redirect whose page isn't published resolves to nothing, so the site
    // never 301s to a page it wouldn't serve.
    const url = byId.get(row.to_page_id);
    if (url) redirects.set(row.from_path, url);
  }

  return { byUrl, byId, redirects };
};

/**
 * Build a page reader, cached per pool.
 *
 * `getPage`, `getRedirect` and `resolveLink` share one cache: the routes are one
 * entry, and one page's blocks are another, so the version is read once a second
 * no matter how many of them a request used.
 */
export const createCmsPages = (options: CmsPagesOptions): CmsPagesReader => {
  const { sql } = options;
  const onSkip = options.onSkip ?? defaultSkipLogger;

  /** The block types, by name, loaded once per page render. */
  const loadBlockTypes = async (): Promise<Map<string, BlockTypeRow>> => {
    const blockTypes = (await sql.unsafe(
      `SELECT name, json_schema, removed_at FROM ${TABLES.blockTypes}`,
    )) as BlockTypeRow[];
    return new Map(blockTypes.map((row) => [row.name, row]));
  };

  /**
   * Build a page from a row and a revision, validating every block.
   *
   * Shared by the published read and the preview read so a draft and a published
   * revision go through exactly the same validation — a block a deploy removed
   * or one that no longer validates is skipped and logged either way.
   */
  const renderPage = async (
    page: PageRow,
    revisionId: string,
  ): Promise<CmsPage | null> => {
    const revisions = (await sql.unsafe(
      `SELECT content FROM ${TABLES.revisions} WHERE id = $1`,
      [revisionId],
    )) as { content: Record<string, unknown> }[];
    const revision = revisions[0];
    if (!revision) {
      onSkip(`page "${page.url}" points at a revision that no longer exists`);
      return null;
    }

    const byName = await loadBlockTypes();
    const blocks = Array.isArray(revision.content.blocks)
      ? revision.content.blocks
      : [];
    const rendered: CmsPageBlock[] = [];

    for (const raw of blocks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        onSkip(`page "${page.url}" has a block that isn't an object`);
        continue;
      }
      const block = raw as Record<string, unknown>;
      const type = block.type;
      if (typeof type !== "string") {
        onSkip(`page "${page.url}" has a block with no type`);
        continue;
      }

      const blockType = byName.get(type);
      if (!blockType) {
        onSkip(
          `page "${page.url}" uses block "${type}", which is not published`,
        );
        continue;
      }
      if (blockType.removed_at !== null) {
        onSkip(
          `page "${page.url}" uses block "${type}", which was removed by a deploy`,
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
          `page "${page.url}" block "${type}" no longer validates — ${detail}`,
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

  const loadPage = async (pageId: string): Promise<CmsPage | null> => {
    const pages = (await sql.unsafe(
      `SELECT ${PAGE_COLUMNS}
       FROM ${TABLES.pages} WHERE id = $1`,
      [pageId],
    )) as PageRow[];

    const page = pages[0];
    // Never published: nothing to render, and nothing wrong.
    if (!page?.published_revision_id) return null;
    return await renderPage(page, page.published_revision_id);
  };

  /**
   * The draft read a valid preview token triggers, uncached and by URL.
   *
   * The page is looked up by its path regardless of whether it is published —
   * a page previewed before it ever goes live has no published revision to find
   * — and only the token's own subject uses its newest revision. Every other
   * page, and every page reached with a slot's token, reads as published.
   */
  const loadPreviewPage = async (
    path: string,
    access: PreviewAccess,
  ): Promise<CmsPage | null> => {
    const pages = (await sql.unsafe(
      `SELECT ${PAGE_COLUMNS}
       FROM ${TABLES.pages} WHERE url = $1`,
      [path],
    )) as PageRow[];

    const page = pages[0];
    if (!page) return null;

    let revisionId = page.published_revision_id;
    if (access.subjectType === "page" && access.subjectId === page.id) {
      revisionId = await latestRevisionId(sql, "page", page.id);
    }

    if (!revisionId) return null;
    return await renderPage(page, revisionId);
  };

  /**
   * The routing table's last successful load, kept across failures.
   *
   * A failure to read the table is transient — the CMS is down, or
   * mid-migration — and the site must keep rendering with the routes it last
   * saw rather than 404 every page. It survives `invalidate()`: it is a failure
   * fallback, not a cache entry, so it is replaced by the next successful load
   * rather than dropped with the cached entries. The content may be newer than
   * the fallback, but it is the best available.
   */
  let lastGoodRoutes: RouteTable | null = null;
  /** The last routes failure with nothing good to serve, and when it happened. */
  let routesError: { error: unknown; at: number } | null = null;
  /** When "serving the last good table" was last reported, for the back-off. */
  let routesErrorLoggedAt = Number.NEGATIVE_INFINITY;
  const pollMs = options.versionPollMs ?? CONTENT_VERSION_POLL_MS;

  /**
   * Load the routing table, tolerating a failure.
   *
   * With a last good table, the failure is logged once per interval and that
   * table is served, so a site keeps its links and 301s while the database is
   * briefly unreachable. With none (the first read after boot), the failure is
   * remembered for one poll interval so a broken database is queried at most
   * once a second rather than once per request, and re-thrown for the caller to
   * report.
   */
  const loadRoutesResilient = async (): Promise<RouteTable> => {
    const now = options.now?.() ?? Date.now();
    if (
      lastGoodRoutes === null &&
      routesError !== null &&
      now - routesError.at < pollMs
    ) {
      throw routesError.error;
    }

    try {
      const routes = await loadRoutes(sql);
      lastGoodRoutes = routes;
      routesError = null;
      return routes;
    } catch (error) {
      if (lastGoodRoutes !== null) {
        if (now - routesErrorLoggedAt >= pollMs) {
          onSkip(
            `could not read the CMS routing table, serving the last good one: ${describe(error)}`,
          );
          routesErrorLoggedAt = now;
        }
        return lastGoodRoutes;
      }
      routesError = { error, at: now };
      throw error;
    }
  };

  // One loader dispatching on the key: `ContentCache` caches one value per key
  // but has a single `load`, so the key is what tells it what to read on a miss.
  const loadByKey = async (key: string): Promise<unknown> => {
    if (key === "routes") return await loadRoutesResilient();
    const prefix = "page:";
    if (key.startsWith(prefix)) return await loadPage(key.slice(prefix.length));
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
    async getPage(
      path: string,
      readOptions?: { preview?: PreviewAccess | null },
    ): Promise<CmsPage | null> {
      const canonical = canonicalPath(path);
      const preview = readOptions?.preview;
      try {
        // Preview bypasses the cache both ways: a draft must not be written
        // into the published cache, and a published page must not be served
        // from it while the editor is looking at an unpublished change.
        if (preview) return await loadPreviewPage(canonical, preview);

        const routes = (await cache.get("routes")) as RouteTable;
        const pageId = routes.byUrl.get(canonical);
        // A miss is a 404, not a query: no page is loaded and no cache entry is
        // keyed by the path that wasn't there.
        if (!pageId) return null;
        return (await cache.get(`page:${pageId}`)) as CmsPage | null;
      } catch (error) {
        onSkip(`could not read page "${canonical}": ${describe(error)}`);
        return null;
      }
    },

    async getRedirect(path: string): Promise<string | null> {
      const canonical = canonicalPath(path);
      try {
        const routes = (await cache.get("routes")) as RouteTable;
        return routes.redirects.get(canonical) ?? null;
      } catch (error) {
        onSkip(`could not read redirect "${canonical}": ${describe(error)}`);
        return null;
      }
    },

    async resolveLink(link: LinkValue): Promise<string | null> {
      if (link.type === "url") return link.url;
      try {
        const routes = (await cache.get("routes")) as RouteTable;
        return routes.byId.get(link.pageId) ?? null;
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

/**
 * What the catch-all hands the site's render function alongside the page.
 *
 * The render function may itself read slots (a CMS page whose template also
 * mounts `slot("…")`). Passing the request's preview access through is what lets
 * a slot previewed inside a CMS-served page render its draft: the site forwards
 * `preview` to `getSlot`, and `null` means the published read, so a caller can
 * pass it on without branching.
 */
export interface CmsPageRenderContext {
  /** The preview access the request carried, or `null` for a published read. */
  preview: PreviewAccess | null;
  /** The request being served. */
  req: Request;
}

export interface CmsPageRouteOptions extends CmsPagesOptions {
  /**
   * Use this reader instead of building one. A site that already holds the
   * process-wide reader (or one it built with custom options) can pass it so
   * the catch-all shares its cache and its version poll.
   */
  reader?: CmsPagesReader;
  /**
   * Render a resolved page to a Response. The site owns the layout and the block
   * render functions; the plugin owns the redirect/page/404 decision around it.
   * The context carries the preview access, so the page can forward it to any
   * slot it mounts — which is how a slot preview works on a CMS-served page.
   */
  render: (
    page: CmsPage,
    context: CmsPageRenderContext,
  ) => Response | Promise<Response>;
}

/**
 * The catch-all a site mounts in its fallback, just before its 404.
 *
 * Order is the spec's: a redirect answers first (a 301 to the page's current
 * URL, query string preserved), then a published page is rendered, then `null`
 * so the site's own `render404` runs. A non-GET/HEAD request is left to the site
 * — the CMS serves pages, not form posts.
 *
 * With no `reader` and no custom `now`/`versionPollMs`/`onSkip`, it uses the
 * process-wide reader for `sql` (the same one `getPage` and
 * `listSitemapEntries` use), so mounting the catch-all and reading a page
 * directly run one cache and one version poll rather than two.
 */
export const createCmsPageRoute = (
  options: CmsPageRouteOptions,
): ((req: Request) => Promise<Response | null>) => {
  const reader =
    options.reader ??
    (options.now || options.versionPollMs !== undefined || options.onSkip
      ? createCmsPages(options)
      : getCmsPagesReader(options.sql));
  const onSkip = options.onSkip ?? defaultSkipLogger;

  return async (req: Request): Promise<Response | null> => {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;

    const url = new URL(req.url);

    // Redirects answer first, before preview (review round 3, Q2): a page's old
    // URL 301s to its current one, and the query string rides along, so a
    // preview opened against a path that has since moved still lands on the
    // page the token names — with `?cms_preview=…` intact.
    const redirected = await reader.getRedirect(url.pathname);
    const location = redirected === null ? null : sameOriginPath(redirected);
    if (location !== null) {
      return new Response("", {
        status: 301,
        headers: {
          Location: `${location}${url.search}`,
          // A rename is rare and the target is stable, so a browser may keep the
          // 301 for an hour rather than asking on every visit.
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Preview: a valid token reads the draft for its subject, bypassing the
    // published cache. An unknown or expired token resolves to `null` and the
    // request takes the published path below, unchanged.
    const preview = await getPreviewAccess(options.sql, req, { onSkip });
    if (preview) {
      const page = await reader.getPage(url.pathname, { preview });
      if (page) {
        return await applyPreview(
          await options.render(page, { preview, req }),
          preview,
        );
      }
      return null;
    }

    const page = await reader.getPage(url.pathname);
    if (page) return await options.render(page, { preview: null, req });

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
export const getPage = (
  sql: SQL,
  path: string,
  options?: { preview?: PreviewAccess | null },
): Promise<CmsPage | null> => getCmsPagesReader(sql).getPage(path, options);

/** The published pages a site merges into its sitemap. */
export const listSitemapEntries = (sql: SQL): Promise<CmsSitemapEntry[]> =>
  getCmsPagesReader(sql).listSitemapEntries();
