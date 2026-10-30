import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { block, text } from "../fields";
import { hashPreviewToken } from "../preview";
import { createCmsMedia } from "./media";
import {
  type CmsPage,
  createCmsPageRoute,
  createCmsPages,
  getPage,
  sameOriginPath,
} from "./pages";
import { createContentReader, getSlot } from "./slots";

const PAGE_ROW: {
  id: string;
  page_type: string;
  url: string;
  title: string;
  seo_description: string | null;
  social_image_id: string | null;
  published_revision_id: string | null;
  updated_at: Date;
} = {
  id: "page-1",
  page_type: "landing",
  url: "/about",
  title: "About us",
  seo_description: "Who we are.",
  social_image_id: null,
  published_revision_id: "rev-1",
  updated_at: new Date("2026-10-10T09:00:00.000Z"),
};

/** An unpublished page: only the preview read's direct by-id SELECT finds it. */
const DRAFT_PAGE: typeof PAGE_ROW = {
  ...PAGE_ROW,
  id: "page-2",
  url: "/marketing-page",
  title: "Marketing page",
  published_revision_id: null,
};

const BLOCK_TYPES = [
  {
    name: "hero",
    json_schema: { type: "object" },
    removed_at: null as Date | null,
  },
];

/**
 * A pool that answers the reader's queries in memory.
 *
 * `redirects` maps an old path to the id of the page it points at, the way the
 * real `cms_redirects` row does; the reader resolves that id to the page's
 * current URL through the published pages it loaded. `draft` is a second,
 * unpublished page: the routing table must not know it, but a preview's direct
 * by-id SELECT must find it. The version and the content are mutable so a test
 * can prove a publish is picked up.
 */
const fakeSql = (
  options: {
    page?: typeof PAGE_ROW | null;
    draft?: typeof PAGE_ROW;
    content?: { blocks: Record<string, unknown>[] };
    redirects?: Record<string, string>;
    blockTypes?: typeof BLOCK_TYPES;
  } = {},
) => {
  const page = options.page === undefined ? PAGE_ROW : options.page;
  const state = {
    version: 1,
    content: options.content ?? {
      blocks: [{ type: "hero", heading: "Hello" }],
    },
  };
  const redirects = options.redirects ?? {};
  const blockTypes = options.blockTypes ?? BLOCK_TYPES;
  const rows: (typeof PAGE_ROW)[] = [page, options.draft ?? null].filter(
    (row): row is typeof PAGE_ROW => row !== null,
  );
  const published = rows.filter((row) => row.published_revision_id !== null);

  const sql = {
    unsafe: (query: string, params: unknown[] = []) => {
      if (query.includes("cms_meta")) {
        return Promise.resolve([{ content_version: state.version }]);
      }
      if (query.includes("cms_redirects")) {
        return Promise.resolve(
          Object.entries(redirects).map(([from_path, to_page_id]) => ({
            from_path,
            to_page_id,
          })),
        );
      }
      if (query.includes("cms_pages")) {
        if (query.includes("WHERE id = $1")) {
          // Pin the two projections that reach a page by id: `resolveLink`'s
          // preview read selects `url` alone, and a page read selects the full
          // column list. An unrecognised query rejects rather than falling back
          // to a full row, so a reworded production query cannot pass merely
          // because `rows[0]?.url` still reads.
          const normalised = query.replace(/\s+/g, " ").trim();
          const urlOnly = /^SELECT url FROM \S+ WHERE id = \$1$/.test(
            normalised,
          );
          const fullRow =
            /^SELECT id, page_type, url, title, seo_description, social_image_id, published_revision_id, updated_at FROM \S+ WHERE id = \$1$/.test(
              normalised,
            );
          if (!urlOnly && !fullRow) {
            return Promise.reject(
              new Error(`unexpected by-id query: ${query}`),
            );
          }
          const row = rows.find((candidate) => candidate.id === params[0]);
          if (!row) return Promise.resolve([]);
          return Promise.resolve(urlOnly ? [{ url: row.url }] : [row]);
        }
        // The sitemap query is the only one that reads `updated_at`.
        if (query.includes("updated_at")) {
          return Promise.resolve(
            published.map((row) => ({
              url: row.url,
              updated_at: row.updated_at,
            })),
          );
        }
        // The routing table: every published page's URL.
        return Promise.resolve(
          published.map((row) => ({ id: row.id, url: row.url })),
        );
      }
      if (query.includes("cms_revisions")) {
        return Promise.resolve([{ content: state.content }]);
      }
      if (query.includes("cms_block_types")) {
        return Promise.resolve(blockTypes);
      }
      return Promise.resolve([]);
    },
  } as unknown as SQL;

  return { state, sql, redirects };
};

describe("createCmsPages", () => {
  test("reads a published page and its validated blocks", async () => {
    const { sql } = fakeSql();
    const pages = createCmsPages({ sql, onSkip: () => {} });

    const page = await pages.getPage("/about");
    expect(page?.title).toBe("About us");
    expect(page?.blocks).toEqual([{ type: "hero", heading: "Hello" }]);
  });

  // The column is a media id, not a pasted URL: a site resolves it through the
  // plugin's media reader, so the reader has to carry it through unchanged.
  test("carries the page's social image id", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, social_image_id: "media-1" },
    });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect((await pages.getPage("/about"))?.socialImageId).toBe("media-1");
  });

  // The reader's contract is "null means unset", and the editor trims on write,
  // but a hand edit or an old pull can leave a whitespace-only description. A
  // site reading the field directly rather than through `pageSeo` must not get
  // one it would render as a blank tag.
  test("treats a whitespace-only SEO description as unset", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, seo_description: "   " },
    });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect((await pages.getPage("/about"))?.seoDescription).toBeNull();
  });

  test("trims a padded SEO description", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, seo_description: "  Who we are.  " },
    });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect((await pages.getPage("/about"))?.seoDescription).toBe("Who we are.");
  });

  test("returns nothing for a page that is only a draft", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, published_revision_id: null },
    });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect(await pages.getPage("/about")).toBeNull();
  });

  test("treats a trailing slash as the same path", async () => {
    const { sql } = fakeSql();
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect((await pages.getPage("/about/"))?.title).toBe("About us");
    expect(await pages.getRedirect("/about/")).toBeNull();
  });

  test("resolves a redirect to the page's current URL", async () => {
    const { sql } = fakeSql({ redirects: { "/old": "page-1" } });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect(await pages.getRedirect("/old")).toBe("/about");
    expect(await pages.getRedirect("/nope")).toBeNull();
  });

  test("resolves a page link by id, and a free URL as itself", async () => {
    const { sql } = fakeSql();
    const pages = createCmsPages({ sql, onSkip: () => {} });

    expect(await pages.resolveLink({ type: "page", pageId: "page-1" })).toBe(
      "/about",
    );
    expect(
      await pages.resolveLink({ type: "url", url: "https://elsewhere.test" }),
    ).toBe("https://elsewhere.test");
  });

  test("resolves a redirect and a page link only through published pages", async () => {
    const { sql } = fakeSql({ redirects: { "/gone": "page-2" } });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    // `page-2` is not in the published set the routes were built from.
    expect(await pages.getRedirect("/gone")).toBeNull();
    expect(
      await pages.resolveLink({ type: "page", pageId: "page-2" }),
    ).toBeNull();
  });

  describe("resolveLink during preview", () => {
    const pagePreview = { subjectType: "page" as const, subjectId: "page-2" };
    const slotPreview = { subjectType: "slot" as const, subjectId: "slot-1" };

    test("resolves a draft page the token names", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const pages = createCmsPages({ sql, onSkip: () => {} });

      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-2" },
          { preview: pagePreview },
        ),
      ).toBe("/marketing-page");
    });

    // A page can link the same draft many times; the per-access memo means the
    // render reads it once rather than once per link.
    test("reads a draft once per preview access", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const inner = sql as unknown as {
        unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
      };
      let draftReads = 0;
      const counting = {
        unsafe: (query: string, params?: unknown[]) => {
          if (/^SELECT url FROM/.test(query.trim())) draftReads += 1;
          return inner.unsafe(query, params);
        },
      } as unknown as SQL;
      const pages = createCmsPages({ sql: counting, onSkip: () => {} });
      const link = { type: "page" as const, pageId: "page-2" };

      expect(await pages.resolveLink(link, { preview: pagePreview })).toBe(
        "/marketing-page",
      );
      expect(await pages.resolveLink(link, { preview: pagePreview })).toBe(
        "/marketing-page",
      );
      expect(draftReads).toBe(1);

      // Another access is another preview and reads again.
      expect(
        await pages.resolveLink(link, { preview: { ...pagePreview } }),
      ).toBe("/marketing-page");
      expect(draftReads).toBe(2);
    });

    test("resolves a published target from the cache, unchanged", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const pages = createCmsPages({ sql, onSkip: () => {} });

      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-1" },
          { preview: pagePreview },
        ),
      ).toBe("/about");
    });

    test("still returns null for a draft without preview access", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const pages = createCmsPages({ sql, onSkip: () => {} });

      expect(
        await pages.resolveLink({ type: "page", pageId: "page-2" }),
      ).toBeNull();
      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-2" },
          { preview: null },
        ),
      ).toBeNull();
    });

    // The plan's answer to the ticket's open question: any valid access counts,
    // not only a page token for the target, so cross-links between drafts work.
    test("a slot token resolves a draft page too", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const pages = createCmsPages({ sql, onSkip: () => {} });

      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-2" },
          { preview: slotPreview },
        ),
      ).toBe("/marketing-page");
    });

    test("returns null for an unknown page id during preview", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const pages = createCmsPages({ sql, onSkip: () => {} });

      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-3" },
          { preview: pagePreview },
        ),
      ).toBeNull();
    });

    // The draft read is uncached, and the routes table is loaded from published
    // pages only. Warming it on a preview must not leave the draft's URL in it:
    // a later published read still misses, and the table is loaded once.
    test("a draft resolved during preview never enters the route cache", async () => {
      const { sql } = fakeSql({ draft: DRAFT_PAGE });
      const inner = sql as unknown as {
        unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
      };
      let routeLoads = 0;
      const counting = {
        unsafe: (query: string, params?: unknown[]) => {
          if (query.includes("published_revision_id IS NOT NULL")) {
            routeLoads += 1;
          }
          return inner.unsafe(query, params);
        },
      } as unknown as SQL;
      const pages = createCmsPages({
        sql: counting,
        now: () => 0,
        onSkip: () => {},
      });

      expect(
        await pages.resolveLink(
          { type: "page", pageId: "page-2" },
          { preview: pagePreview },
        ),
      ).toBe("/marketing-page");

      // The same link outside a preview: the cached table knows nothing of it.
      expect(
        await pages.resolveLink({ type: "page", pageId: "page-2" }),
      ).toBeNull();
      // And the draft is not served as a published page either.
      expect(await pages.getPage("/marketing-page")).toBeNull();

      expect(routeLoads).toBe(1);
    });
  });

  test("lists only published pages as sitemap entries", async () => {
    const { sql } = fakeSql();
    const pages = createCmsPages({ sql, onSkip: () => {} });

    const entries = await pages.listSitemapEntries();
    expect(entries.map((entry) => entry.url)).toEqual(["/about"]);

    const draftOnly = createCmsPages({
      sql: fakeSql({ page: null }).sql,
      onSkip: () => {},
    });
    expect(await draftOnly.listSitemapEntries()).toEqual([]);
  });

  test("a publish moves the content version and drops the cache", async () => {
    const { state, sql } = fakeSql();
    let now = 0;
    const pages = createCmsPages({
      sql,
      now: () => now,
      onSkip: () => {},
    });

    expect((await pages.getPage("/about"))?.blocks).toEqual([
      { type: "hero", heading: "Hello" },
    ]);

    // A publish bumps the version; the next read past the poll interval must
    // not serve the old blocks.
    state.content = { blocks: [{ type: "hero", heading: "Published" }] };
    state.version += 1;
    now += 1000;

    expect((await pages.getPage("/about"))?.blocks).toEqual([
      { type: "hero", heading: "Published" },
    ]);
  });

  test("skips a block that isn't published, and logs it", async () => {
    const { sql } = fakeSql({
      content: { blocks: [{ type: "hero", heading: "Hi" }, { type: "ghost" }] },
    });
    const skipped: string[] = [];
    const pages = createCmsPages({
      sql,
      onSkip: (message) => skipped.push(message),
    });

    const page = await pages.getPage("/about");
    expect(page?.blocks).toEqual([{ type: "hero", heading: "Hi" }]);
    expect(skipped.some((line) => line.includes('"ghost"'))).toBe(true);
  });

  test("never throws when the CMS isn't readable, and logs it", async () => {
    const throwing = {
      unsafe: () => {
        throw new Error('relation "cms_pages" does not exist');
      },
    } as unknown as SQL;
    const skipped: string[] = [];
    const pages = createCmsPages({
      sql: throwing,
      onSkip: (message) => skipped.push(message),
    });

    expect(await pages.getPage("/about")).toBeNull();
    expect(await pages.getRedirect("/about")).toBeNull();
    expect(await pages.listSitemapEntries()).toEqual([]);
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe("createCmsPageRoute (the catch-all)", () => {
  const render = (page: { title: string }) =>
    new Response(`<h1>${page.title}</h1>`, {
      headers: { "Content-Type": "text/html" },
    });

  test("a redirect answers before the page, with a 301", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, url: "/about-us" },
      redirects: { "/about": "page-1" },
    });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(new Request("http://localhost/about?utm=1"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("/about-us?utm=1");
  });

  test("never sends an off-site Location", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, url: "https://evil.example/phish" },
      redirects: { "/about": "page-1" },
    });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(new Request("http://localhost/about"));
    // The redirect target isn't a same-origin path, so it is refused and the
    // request falls through to the page lookup (which has nothing at /about).
    expect(res).toBeNull();
  });

  test("renders a published page", async () => {
    const { sql } = fakeSql();
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(new Request("http://localhost/about"));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain("<h1>About us</h1>");
  });

  test("returns null so the site's own 404 runs", async () => {
    const { sql } = fakeSql({ page: null });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    expect(await route(new Request("http://localhost/missing"))).toBeNull();
  });

  test("a 404 for a new path runs no further queries", async () => {
    const { sql } = fakeSql();
    const base = sql as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    let queries = 0;
    const counting = {
      unsafe: (query: string, params?: unknown[]) => {
        queries += 1;
        return base.unsafe(query, params);
      },
    } as unknown as SQL;
    const route = createCmsPageRoute({
      sql: counting,
      render,
      now: () => 0,
      onSkip: () => {},
    });

    // Warm the cache: the routing table and one page.
    await route(new Request("http://localhost/about"));
    const warm = queries;

    // A path that matches nothing is a lookup in the cached table, not a query
    // keyed by the missing path.
    expect(await route(new Request("http://localhost/missing"))).toBeNull();
    expect(queries).toBe(warm);
  });

  test("ignores a non-GET request, leaving it to the site", async () => {
    const { sql } = fakeSql();
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    expect(
      await route(new Request("http://localhost/about", { method: "POST" })),
    ).toBeNull();
  });
});

describe("sameOriginPath", () => {
  test("keeps a same-origin path and refuses anything off-site", () => {
    expect(sameOriginPath("/about")).toBe("/about");
    expect(sameOriginPath("//evil.example")).toBeNull();
    expect(sameOriginPath("/\\evil.example")).toBeNull();
    expect(sameOriginPath("https://evil.example")).toBeNull();
    expect(sameOriginPath("about")).toBeNull();
  });
});

describe("preview reads", () => {
  /**
   * A pool with a page, a published revision and a newer draft, plus preview
   * token rows. The page query branches on the column it filters by, the way the
   * real reader's do: the catch-all's `id = $1` against the preview read's
   * `url = $1`.
   */
  const previewSql = (options: {
    page?: typeof PAGE_ROW | null;
    published?: string;
    draft?: string;
    redirects?: Record<string, string>;
    tokens?: Record<
      string,
      { subject_type: "page" | "slot"; subject_id: string; expires_at: Date }
    >;
  }) => {
    const page = options.page === undefined ? PAGE_ROW : options.page;
    const published = options.published ?? "Published";
    const draft = options.draft ?? "Draft";
    const tokens = options.tokens ?? {};
    const redirects = options.redirects ?? {};
    const revisions: Record<string, { content: { blocks: unknown[] } }> = {
      "rev-1": { content: { blocks: [{ type: "hero", heading: published }] } },
      "rev-2": { content: { blocks: [{ type: "hero", heading: draft }] } },
    };

    const sql = {
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_preview_tokens")) {
          const row = tokens[params[0] as string];
          if (!row) return Promise.resolve([]);
          const now = params[1] as Date;
          return Promise.resolve(now > row.expires_at ? [] : [row]);
        }
        if (query.includes("cms_redirects")) {
          return Promise.resolve(
            Object.entries(redirects).map(([from_path, to_page_id]) => ({
              from_path,
              to_page_id,
            })),
          );
        }
        if (query.includes("cms_pages")) {
          if (!page) return Promise.resolve([]);
          if (query.includes("WHERE url = $1")) {
            return Promise.resolve(page.url === params[0] ? [page] : []);
          }
          if (query.includes("WHERE id = $1")) {
            return Promise.resolve(page.id === params[0] ? [page] : []);
          }
          // The routing table, as the real reader loads it: published pages
          // only, so an unpublished page is found only by the URL lookup.
          return Promise.resolve(
            page.published_revision_id === null
              ? []
              : [{ id: page.id, url: page.url }],
          );
        }
        if (query.includes("cms_revisions")) {
          if (query.includes("LIMIT 1") && query.includes("target_id")) {
            return Promise.resolve([{ id: "rev-2" }]);
          }
          return Promise.resolve([revisions[params[0] as string] ?? null]);
        }
        if (query.includes("cms_block_types"))
          return Promise.resolve(BLOCK_TYPES);
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    return sql;
  };

  const bannerRender = (page: CmsPage) =>
    new Response(
      `<html><body><h1>${page.title}</h1><p>${String(page.blocks[0]?.heading)}</p></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );

  const pageToken = (subjectId: string) => ({
    [hashPreviewToken("good")]: {
      subject_type: "page" as const,
      subject_id: subjectId,
      expires_at: new Date("2099-01-01T00:00:00Z"),
    },
  });

  const slotToken = (subjectId: string) => ({
    [hashPreviewToken("good")]: {
      subject_type: "slot" as const,
      subject_id: subjectId,
      expires_at: new Date("2099-01-01T00:00:00Z"),
    },
  });

  /** A pool that counts every query, over one of the preview pools above. */
  const countingPreviewSql = (
    sql: SQL,
  ): { sql: SQL; queries: () => number } => {
    const base = sql as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    let queries = 0;
    const counting = {
      unsafe: (query: string, params?: unknown[]) => {
        queries += 1;
        return base.unsafe(query, params);
      },
    } as unknown as SQL;
    return { sql: counting, queries: () => queries };
  };

  test("renders the newest draft, with the banner and no cache", async () => {
    const sql = previewSql({ tokens: pageToken("page-1") });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );

    expect(res?.status).toBe(200);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("X-Robots-Tag")).toBe("noindex");
    const html = await res?.text();
    expect(html).toContain("<p>Draft</p>");
    expect(html).toContain("cms-preview-banner");
  });

  test("previews a page that was never published", async () => {
    const sql = previewSql({
      page: { ...PAGE_ROW, published_revision_id: null },
      tokens: pageToken("page-1"),
    });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );
    expect(await res?.text()).toContain("<p>Draft</p>");
  });

  test("a token for another page leaves this one published", async () => {
    const sql = previewSql({ tokens: pageToken("page-2") });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );
    // Preview access is present, so headers still apply, but the content is the
    // published revision — the token's subject is elsewhere.
    const html = await res?.text();
    expect(html).toContain("<p>Published</p>");
  });

  test("an unknown token falls back to the published view, unbannered", async () => {
    const sql = previewSql({ tokens: pageToken("page-1") });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=wrong"),
    );

    expect(res?.headers.get("Cache-Control")).not.toBe("no-store");
    expect(res?.headers.get("X-Robots-Tag")).not.toBe("noindex");
    const html = await res?.text();
    expect(html).toContain("<p>Published</p>");
    expect(html).not.toContain("cms-preview-banner");
  });

  test("an expired token falls back to the published view", async () => {
    const expired = {
      [hashPreviewToken("old")]: {
        subject_type: "page" as const,
        subject_id: "page-1",
        expires_at: new Date("2020-01-01T00:00:00Z"),
      },
    };
    const sql = previewSql({ tokens: expired });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=old"),
    );
    const html = await res?.text();
    expect(html).toContain("<p>Published</p>");
    expect(html).not.toContain("cms-preview-banner");
  });

  /**
   * Review round 3, Q2: a redirect answers before preview, so a page whose URL
   * has moved still admits a preview opened against the old path — the 301
   * keeps the query string, and the token rides along to the target.
   */
  test("a redirected path carries a valid preview token to the target", async () => {
    const sql = previewSql({
      page: { ...PAGE_ROW, url: "/about-us" },
      redirects: { "/about": "page-1" },
      tokens: pageToken("page-1"),
    });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );

    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("/about-us?cms_preview=good");

    // Following the redirect lands on the target, still previewing the draft.
    const followed = await route(
      new Request(`http://localhost${res?.headers.get("Location")}`),
    );
    expect(followed?.status).toBe(200);
    expect(followed?.headers.get("Cache-Control")).toBe("no-store");
    const html = await followed?.text();
    expect(html).toContain("<p>Draft</p>");
    expect(html).toContain("cms-preview-banner");
  });

  // The slot reader keeps the cache for slots a token does not cover; the page
  // reader has to do the same, or previewing one slot would re-read every page
  // on the site. A slot's token shows the published page, from the cache.
  test("a slot token serves the published page from the cache", async () => {
    const { sql, queries } = countingPreviewSql(
      previewSql({ tokens: slotToken("slot-1") }),
    );
    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => 0 });
    const preview = { subjectType: "slot" as const, subjectId: "slot-1" };

    const first = await pages.getPage("/about", { preview });
    expect(first?.blocks).toEqual([{ type: "hero", heading: "Published" }]);

    const warm = queries();
    const second = await pages.getPage("/about", { preview });
    expect(second?.blocks).toEqual([{ type: "hero", heading: "Published" }]);
    // A second read inside the interval costs nothing: the page stayed cached.
    expect(queries()).toBe(warm);
  });

  // Same for a page token that names a different page: only the token's own
  // page leaves the cache.
  test("a page token for another page serves this one from the cache", async () => {
    const { sql, queries } = countingPreviewSql(
      previewSql({ tokens: pageToken("page-2") }),
    );
    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => 0 });
    const preview = { subjectType: "page" as const, subjectId: "page-2" };

    const first = await pages.getPage("/about", { preview });
    expect(first?.blocks).toEqual([{ type: "hero", heading: "Published" }]);

    const warm = queries();
    const second = await pages.getPage("/about", { preview });
    expect(second?.blocks).toEqual([{ type: "hero", heading: "Published" }]);
    expect(queries()).toBe(warm);
  });

  test("getPage with preview bypasses the cache", async () => {
    const sql = previewSql({ tokens: pageToken("page-1") });
    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => 0 });

    const preview = await pages.getPage("/about", {
      preview: { subjectType: "page", subjectId: "page-1" },
    });
    expect(preview?.blocks).toEqual([{ type: "hero", heading: "Draft" }]);

    // The published read is unaffected and still separate.
    const published = await pages.getPage("/about");
    expect(published?.blocks).toEqual([{ type: "hero", heading: "Published" }]);
  });

  // A1: a page token used to run the uncached `url = $1` page lookup on every
  // path the routing table didn't know — every 404 a previewed page asked for.
  // When the token's page is already published at another URL that lookup can
  // only miss: a page's URL lives on the page row, so a draft cannot move it.
  test("a page token does not run the URL lookup for an unpublished path", async () => {
    const inner = previewSql({ tokens: pageToken("page-1") }) as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    const seen: string[] = [];
    const sql = {
      unsafe: (query: string, params?: unknown[]) => {
        seen.push(query);
        return inner.unsafe(query, params);
      },
    } as unknown as SQL;

    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => 0 });
    const preview = { subjectType: "page" as const, subjectId: "page-1" };

    expect(await pages.getPage("/missing", { preview })).toBeNull();

    const urlLookups = seen.filter(
      (query) =>
        query.includes("cms_pages") && query.includes("WHERE url = $1"),
    );
    expect(urlLookups).toHaveLength(0);
  });

  // The same guard must not hide a genuinely unpublished page: with nothing in
  // the routing table, the token is the only way to reach it, so the URL lookup
  // still runs.
  test("a page token still finds an unpublished page by URL", async () => {
    const inner = previewSql({
      page: { ...PAGE_ROW, published_revision_id: null },
      tokens: pageToken("page-1"),
    }) as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    const seen: string[] = [];
    const sql = {
      unsafe: (query: string, params?: unknown[]) => {
        seen.push(query);
        return inner.unsafe(query, params);
      },
    } as unknown as SQL;

    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => 0 });
    const preview = { subjectType: "page" as const, subjectId: "page-1" };

    const page = await pages.getPage("/about", { preview });
    expect(page?.blocks).toEqual([{ type: "hero", heading: "Draft" }]);
    expect(
      seen.some(
        (query) =>
          query.includes("cms_pages") && query.includes("WHERE url = $1"),
      ),
    ).toBe(true);
  });

  // A1 pins the trade-off the 404 guard makes: a published token page whose URL
  // moved inside the poll window is not in the routing table at its new path
  // yet, and the guard refuses the uncached URL lookup because the token's page
  // is already known by id. It therefore returns null for up to one interval,
  // then recovers when the routing table reloads. A draft cannot move a page's
  // own URL, so this window is the guard's only cost.
  test("a page token 404s until the routing table picks up a moved URL", async () => {
    const page = { ...PAGE_ROW, url: "/about" };
    const state = { version: 1 };
    const revisions: Record<string, { content: { blocks: unknown[] } }> = {
      "rev-1": {
        content: { blocks: [{ type: "hero", heading: "Published" }] },
      },
      "rev-2": { content: { blocks: [{ type: "hero", heading: "Draft" }] } },
    };
    let now = 0;
    const sql = {
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_redirects")) return Promise.resolve([]);
        if (query.includes("cms_pages")) {
          if (query.includes("WHERE url = $1")) {
            return Promise.resolve(page.url === params[0] ? [page] : []);
          }
          if (query.includes("WHERE id = $1")) {
            return Promise.resolve(page.id === params[0] ? [page] : []);
          }
          return Promise.resolve([{ id: page.id, url: page.url }]);
        }
        if (query.includes("cms_revisions")) {
          if (query.includes("LIMIT 1") && query.includes("target_id")) {
            return Promise.resolve([{ id: "rev-2" }]);
          }
          return Promise.resolve([revisions[params[0] as string] ?? null]);
        }
        if (query.includes("cms_block_types")) {
          return Promise.resolve(BLOCK_TYPES);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    const pages = createCmsPages({ sql, onSkip: () => {}, now: () => now });
    const preview = { subjectType: "page" as const, subjectId: "page-1" };

    // Warm the routing table with the page at its old URL and preview the draft.
    expect((await pages.getPage("/about", { preview }))?.blocks).toEqual([
      { type: "hero", heading: "Draft" },
    ]);

    // The page is republished under a new URL. Inside the poll window the
    // routing table still knows only the old path, and the guard refuses the
    // URL lookup because the token's page is in the table by id: the new path
    // resolves to nothing.
    page.url = "/about-us";
    state.version += 1;
    now += 500;
    expect(await pages.getPage("/about-us", { preview })).toBeNull();

    // Past the interval the routing table reloads with the new URL and the
    // preview resolves again.
    now += 1000;
    expect((await pages.getPage("/about-us", { preview }))?.blocks).toEqual([
      { type: "hero", heading: "Draft" },
    ]);
  });

  test("serves a HEAD request that carries a token", async () => {
    const sql = previewSql({ tokens: pageToken("page-1") });
    const route = createCmsPageRoute({
      sql,
      render: bannerRender,
      onSkip: () => {},
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good", {
        method: "HEAD",
      }),
    );

    expect(res?.status).toBe(200);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("the catch-all's render context", () => {
  test("hands the published path a null preview and the request", async () => {
    const { sql } = fakeSql();
    const seen: { preview?: unknown; req?: unknown } = {};
    const route = createCmsPageRoute({
      sql,
      onSkip: () => {},
      render: (page, context) => {
        seen.preview = context.preview;
        seen.req = context.req;
        return new Response(`<h1>${page.title}</h1>`, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    const req = new Request("http://localhost/about");
    await route(req);

    expect(seen.preview).toBeNull();
    expect(seen.req).toBe(req);
  });

  /**
   * The bug review round 1 found: a slot's previewPath can be a CMS-served page,
   * and the slot's draft must render inside it. The catch-all has to hand its
   * render function the preview access so the page can forward it to `getSlot`.
   */
  test("a slot token renders that slot's draft inside a CMS page", async () => {
    const hero = block("hero", { heading: text({ max: 80 }) }, () => null);
    const tokens = {
      [hashPreviewToken("good")]: {
        subject_type: "slot" as const,
        subject_id: "slot-1",
        expires_at: new Date("2099-01-01T00:00:00Z"),
      },
    };

    const sql = {
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_preview_tokens")) {
          const row = tokens[params[0] as string];
          if (!row) return Promise.resolve([]);
          return Promise.resolve(
            (params[1] as Date) > row.expires_at ? [] : [row],
          );
        }
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: 1 }]);
        }
        if (query.includes("cms_pages")) {
          return Promise.resolve([PAGE_ROW]);
        }
        if (query.includes("cms_slots")) {
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "slot-rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "slot-rev-1",
              content: { heading: "Published hero" },
              latest_revision_id: "slot-rev-2",
              latest_content: { heading: "Draft hero" },
            },
          ]);
        }
        if (query.includes("cms_revisions")) {
          if (query.includes("LIMIT 1") && query.includes("target_id")) {
            return Promise.resolve([{ id: "slot-rev-2" }]);
          }
          const id = params[0] as string;
          const heading =
            id === "slot-rev-2"
              ? "Draft hero"
              : id === "slot-rev-1"
                ? "Published hero"
                : "Page";
          return Promise.resolve([{ content: { heading } }]);
        }
        if (query.includes("cms_block_types")) {
          return Promise.resolve([
            { name: "hero", json_schema: { type: "object" }, removed_at: null },
          ]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    const route = createCmsPageRoute({
      sql,
      onSkip: () => {},
      render: async (page, { preview }) => {
        const heroContent = await getSlot(sql, "home.hero", {
          block: hero,
          preview,
        });
        return new Response(
          `<html><body><h1>${page.title}</h1><p>${String(heroContent?.heading)}</p></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );

    const html = await res?.text();
    // The page itself is published — the token is for a slot — but the slot's
    // draft is rendered inside it, under the banner and no-cache headers.
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(html).toContain("<h1>About us</h1>");
    expect(html).toContain("<p>Draft hero</p>");
    expect(html).toContain("cms-preview-banner");
  });
});

describe("reader sharing and routing-table failures", () => {
  const render = (page: { title: string }) =>
    new Response(`<h1>${page.title}</h1>`, {
      headers: { "Content-Type": "text/html" },
    });

  const isRoutesQuery = (query: string): boolean =>
    query.includes("cms_pages") &&
    query.includes("published_revision_id IS NOT NULL") &&
    !query.includes("updated_at");

  /** A pool whose routes query can be made to fail, counting that query. */
  const flakySql = (options: Parameters<typeof fakeSql>[0] = {}) => {
    const { state, sql, redirects } = fakeSql(options);
    const base = sql as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    const counters = { routeQueries: 0, fail: false };
    const flaky = {
      unsafe: (query: string, params?: unknown[]) => {
        if (isRoutesQuery(query)) {
          counters.routeQueries += 1;
          if (counters.fail) throw new Error("the routes query is down");
        }
        return base.unsafe(query, params);
      },
    } as unknown as SQL;
    return { state, counters, sql: flaky, redirects };
  };

  test("the 301 carries a cache lifetime", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, url: "/about-us" },
      redirects: { "/about": "page-1" },
    });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(new Request("http://localhost/about"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  // A preview must not be cached anywhere on the way, so a 301 that still
  // carries the token is `no-store` rather than the usual hour-long lifetime.
  test("a 301 carrying a preview token is not cached", async () => {
    const { sql } = fakeSql({
      page: { ...PAGE_ROW, url: "/about-us" },
      redirects: { "/about": "page-1" },
    });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(
      new Request("http://localhost/about?cms_preview=good"),
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("/about-us?cms_preview=good");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  // A site that mounts the catch-all and also reads a page directly should pay
  // for one cache and one poll, not two.
  test("shares the pool reader with a direct getPage when no options are given", async () => {
    const { sql } = fakeSql();
    const base = sql as unknown as {
      unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
    };
    let queries = 0;
    const counting = {
      unsafe: (query: string, params?: unknown[]) => {
        queries += 1;
        return base.unsafe(query, params);
      },
    } as unknown as SQL;

    // No `now`, `versionPollMs` or `onSkip`: the default reader for the pool.
    const route = createCmsPageRoute({ sql: counting, render });
    await route(new Request("http://localhost/about"));
    const warm = queries;

    // The direct read rides the route's cache: no query at all.
    expect((await getPage(counting, "/about"))?.title).toBe("About us");
    expect(queries).toBe(warm);
  });

  test("serves the last good routing table when a later load fails", async () => {
    const { state, counters, sql } = flakySql();
    let now = 0;
    const skipped: string[] = [];
    const pages = createCmsPages({
      sql,
      now: () => now,
      onSkip: (message) => skipped.push(message),
    });

    expect((await pages.getPage("/about"))?.title).toBe("About us");

    // A publish moves the version; the next routes load fails.
    counters.fail = true;
    state.version += 1;
    now += 1000;

    // The last good table is served, and the failure is reported.
    expect((await pages.getPage("/about"))?.title).toBe("About us");
    expect(skipped.some((line) => line.includes("last good"))).toBe(true);
    const afterFailure = counters.routeQueries;

    // Backed off: another request inside the interval does not re-query.
    now += 100;
    expect((await pages.getPage("/about"))?.title).toBe("About us");
    expect(counters.routeQueries).toBe(afterFailure);
  });

  test("caches a routes failure for one interval when there is no last good table", async () => {
    const { counters, sql } = flakySql();
    counters.fail = true;
    let now = 0;
    const pages = createCmsPages({
      sql,
      now: () => now,
      onSkip: () => {},
    });

    expect(await pages.getPage("/about")).toBeNull();
    expect(counters.routeQueries).toBe(1);

    // Inside the interval the stored failure is re-thrown without a query.
    now += 100;
    expect(await pages.getPage("/about")).toBeNull();
    expect(counters.routeQueries).toBe(1);

    // Past the interval it tries again.
    now += 1000;
    expect(await pages.getPage("/about")).toBeNull();
    expect(counters.routeQueries).toBe(2);
  });

  // The failure must not be frozen into the cache: once the database recovers,
  // the next read past the back-off loads a fresh table rather than serving the
  // stale fallback until the next publish.
  test("recovers a fresh routing table once a failed load succeeds again", async () => {
    const { state, counters, sql, redirects } = flakySql({
      redirects: { "/old": "page-1" },
    });
    let now = 0;
    const pages = createCmsPages({
      sql,
      now: () => now,
      onSkip: () => {},
    });

    expect(await pages.getRedirect("/old")).toBe("/about");

    // A publish moves the version and the next routes load fails.
    counters.fail = true;
    state.version += 1;
    now += 1000;
    expect(await pages.getRedirect("/old")).toBe("/about");
    const afterFailure = counters.routeQueries;

    // The database comes back and a new redirect exists. Past the back-off the
    // fresh table is loaded and the new route resolves.
    counters.fail = false;
    redirects["/new"] = "page-1";
    now += 1000;
    expect(await pages.getRedirect("/new")).toBe("/about");
    expect(counters.routeQueries).toBe(afterFailure + 1);
  });
});

describe("one content_version poll per pool", () => {
  /** A pool answering both the slot and the page reader, counting version reads. */
  const sharedSql = () => {
    const state = { versionReads: 0, version: 1 };
    const sql = {
      unsafe: (query: string) => {
        if (query.includes("cms_meta")) {
          state.versionReads += 1;
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "slot-rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "slot-rev-1",
              content: { heading: "Hero" },
            },
          ]);
        }
        if (query.includes("cms_pages")) {
          return Promise.resolve([{ id: "page-1", url: "/about" }]);
        }
        if (query.includes("cms_media")) {
          return Promise.resolve([
            {
              id: "media-1",
              alt: "A fox",
              width: 960,
              height: 540,
              focal_x: 0.5,
              focal_y: 0.5,
              variants: [],
            },
          ]);
        }
        if (query.includes("cms_revisions")) {
          return Promise.resolve([{ content: { blocks: [] } }]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;
    return { state, sql };
  };

  test("the slot, page and media readers share one poll", async () => {
    const { state, sql } = sharedSql();
    const slots = createContentReader({ sql, onSkip: () => {} });
    const pages = createCmsPages({ sql, onSkip: () => {} });
    const media = createCmsMedia({ sql, onSkip: () => {} });

    await slots.getSlot("home.hero");
    await pages.getPage("/about");
    await media.getMedia("media-1");
    // One `content_version` read for the process, not one per reader.
    expect(state.versionReads).toBe(1);

    // A second read inside the interval shares the poll too.
    await slots.getSlot("home.hero");
    await pages.getPage("/about");
    await media.getMedia("media-1");
    expect(state.versionReads).toBe(1);
  });

  // An invalidate is a hard reset, and with a shared poll that has to reach the
  // poll: invalidating the slot reader forces the page reader's next read back
  // to the database as well.
  test("invalidating one reader forces the shared poll to re-read", async () => {
    const { state, sql } = sharedSql();
    const slots = createContentReader({ sql, onSkip: () => {} });
    const pages = createCmsPages({ sql, onSkip: () => {} });

    await slots.getSlot("home.hero");
    expect(state.versionReads).toBe(1);

    slots.invalidate();
    await pages.getPage("/about");
    expect(state.versionReads).toBe(2);
  });
});
