import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createCmsPageRoute, createCmsPages } from "./pages";

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
    removed_at: null,
  },
];

/**
 * A pool that answers the reader's queries in memory.
 *
 * `redirects` maps an old path to the current URL of the page it points at, the
 * way the real join does. The version is a mutable number so a test can prove a
 * publish is picked up after the interval.
 */
const fakeSql = (
  options: {
    page?: typeof PAGE_ROW | null;
    content?: Record<string, unknown>;
    redirects?: Record<string, string>;
  } = {},
) => {
  const state = { version: 1 };
  const page = options.page === undefined ? PAGE_ROW : options.page;
  const content = options.content ?? {
    blocks: [{ type: "hero", heading: "Hello" }],
  };
  const redirects = options.redirects ?? {};

  const sql = {
    unsafe: (query: string, params: unknown[] = []) => {
      if (query.includes("cms_meta")) {
        return Promise.resolve([{ content_version: state.version }]);
      }
      if (query.includes("cms_redirects")) {
        const from = params[0] as string;
        const target = redirects[from];
        return Promise.resolve(target ? [{ url: target }] : []);
      }
      if (query.includes("published_revision_id IS NOT NULL")) {
        return Promise.resolve(
          page ? [{ url: page.url, updated_at: page.updated_at }] : [],
        );
      }
      if (query.includes("cms_pages")) {
        if (query.includes("WHERE id = $1")) {
          const id = params[0];
          return Promise.resolve(
            page && page.id === id ? [{ url: page.url }] : [],
          );
        }
        if (!page) return Promise.resolve([]);
        const url = params[0];
        return Promise.resolve(page.url === url ? [page] : []);
      }
      if (query.includes("cms_revisions")) {
        return Promise.resolve([{ content }]);
      }
      if (query.includes("cms_block_types")) {
        return Promise.resolve(BLOCK_TYPES);
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

  test("resolves a redirect to the page's current URL", async () => {
    const { sql } = fakeSql({ redirects: { "/old": "/about" } });
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
    const { sql } = fakeSql({ redirects: { "/about": "/about-us" } });
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    const res = await route(new Request("http://localhost/about?utm=1"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("/about-us?utm=1");
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

  test("ignores a non-GET request, leaving it to the site", async () => {
    const { sql } = fakeSql();
    const route = createCmsPageRoute({ sql, render, onSkip: () => {} });

    expect(
      await route(new Request("http://localhost/about", { method: "POST" })),
    ).toBeNull();
  });
});
