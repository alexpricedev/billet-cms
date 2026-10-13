import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createCmsPageRoute, createCmsPages, sameOriginPath } from "./pages";

const PAGE_ROW: {
  id: string;
  page_type: string;
  url: string;
  title: string;
  seo_description: string | null;
  social_image: string | null;
  published_revision_id: string | null;
  updated_at: Date;
} = {
  id: "page-1",
  page_type: "landing",
  url: "/about",
  title: "About us",
  seo_description: "Who we are.",
  social_image: null,
  published_revision_id: "rev-1",
  updated_at: new Date("2026-10-10T09:00:00.000Z"),
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
 * current URL through the published pages it loaded. The version and the content
 * are mutable so a test can prove a publish is picked up.
 */
const fakeSql = (
  options: {
    page?: typeof PAGE_ROW | null;
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
  const published = page?.published_revision_id ? page : null;

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
          const id = params[0];
          return Promise.resolve(page && page.id === id ? [page] : []);
        }
        // The sitemap query is the only one that reads `updated_at`.
        if (query.includes("updated_at")) {
          return Promise.resolve(
            published
              ? [{ url: published.url, updated_at: published.updated_at }]
              : [],
          );
        }
        // The routing table: every published page's URL.
        return Promise.resolve(
          published ? [{ id: published.id, url: published.url }] : [],
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

  return { state, sql };
};

describe("createCmsPages", () => {
  test("reads a published page and its validated blocks", async () => {
    const { sql } = fakeSql();
    const pages = createCmsPages({ sql, onSkip: () => {} });

    const page = await pages.getPage("/about");
    expect(page?.title).toBe("About us");
    expect(page?.blocks).toEqual([{ type: "hero", heading: "Hello" }]);
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
