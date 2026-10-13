import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, pageType, text } from "@alexpricedev/billet-cms/fields";
import { seedPageType } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../database";
import {
  createPage,
  deletePage,
  getPageById,
  getPageByUrl,
  listPageOptions,
  listPages,
  listRedirects,
  normalisePageUrl,
  updatePageSettings,
} from "./pages";

const hero = block("hero", { heading: text({ max: 80 }) }, () => null);
const landing = pageType("landing", { allowedBlocks: [hero] });
const article = pageType("article", { allowedBlocks: [hero] });

describe("normalisePageUrl", () => {
  test("adds the leading slash a bare segment is missing", () => {
    expect(normalisePageUrl("about")).toEqual({ ok: true, url: "/about" });
  });

  test("strips a trailing slash and collapses repeats", () => {
    expect(normalisePageUrl("/about/")).toEqual({ ok: true, url: "/about" });
    expect(normalisePageUrl("/a//b/")).toEqual({ ok: true, url: "/a/b" });
    expect(normalisePageUrl("  /about  ")).toEqual({ ok: true, url: "/about" });
  });

  test("keeps the root as the root", () => {
    expect(normalisePageUrl("/")).toEqual({ ok: true, url: "/" });
  });

  test("refuses an empty URL and one with a query or fragment", () => {
    expect(normalisePageUrl("   ").ok).toBe(false);
    expect(normalisePageUrl("/about?x=1").ok).toBe(false);
    expect(normalisePageUrl("/about#top").ok).toBe(false);
    expect(normalisePageUrl("/a b").ok).toBe(false);
  });
});

describe("page CRUD", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedPageType(db, landing);
  });

  const create = (url: string, title = "About us") =>
    createPage({
      pageType: "landing",
      url,
      title,
      seoDescription: "Who we are.",
      socialImage: "/og/about.png",
    });

  test("creates a page and reads it back by URL", async () => {
    const created = await create("about");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.page.url).toBe("/about");
    const found = await getPageByUrl("/about");
    expect(found?.title).toBe("About us");
    expect(found?.seoDescription).toBe("Who we are.");
    expect(found?.socialImage).toBe("/og/about.png");
    expect(found?.publishedRevisionId).toBeNull();
  });

  test("lists pages in URL order and offers them to the link picker", async () => {
    await create("zebra", "Zebra");
    await create("apple", "Apple");

    expect((await listPages()).map((page) => page.url)).toEqual([
      "/apple",
      "/zebra",
    ]);
    expect((await listPageOptions()).map((option) => option.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
  });

  test("refuses a second page on the same URL", async () => {
    await create("/about");
    const again = await create("about/");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.issues[0]?.path).toBe("url");
    expect(again.issues[0]?.message).toContain("already uses this URL");
  });

  test("refuses settings that are invalid before touching the database", async () => {
    const result = await createPage({
      pageType: "landing",
      url: "",
      title: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "title",
      "url",
    ]);
    expect(await listPages()).toEqual([]);
  });

  test("refuses a page type that isn't published", async () => {
    const result = await createPage({
      pageType: "nope",
      url: "/about",
      title: "About us",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("pageType");
    expect(result.issues[0]?.message).toContain("published page type");
    expect(await listPages()).toEqual([]);
  });

  test("refuses a page type a deploy removed", async () => {
    await seedPageType(db, article);
    await db`UPDATE cms_page_types SET removed_at = NOW() WHERE name = 'article'`;

    const result = await createPage({
      pageType: "article",
      url: "/news",
      title: "News",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("pageType");
  });

  test("allows changing a page to another published page type", async () => {
    await seedPageType(db, article);
    const created = await create("/about");
    if (!created.ok) throw new Error("create failed");

    const changed = await updatePageSettings({
      pageId: created.page.id,
      pageType: "article",
      url: "/about",
      title: "About us",
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.page.pageType).toBe("article");
  });

  test("deletes a page and its redirects", async () => {
    const created = await create("/about");
    if (!created.ok) throw new Error("create failed");
    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    expect(await listRedirects()).toHaveLength(1);

    expect(await deletePage(created.page.id)).toBe(true);
    expect(await getPageById(created.page.id)).toBeNull();
    expect(await listRedirects()).toEqual([]);
  });
});

describe("redirects on URL change", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedPageType(db, landing);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("renaming a page writes a 301 from the old URL", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    const renamed = await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.page.url).toBe("/about-us");

    expect(await getPageByUrl("/about")).toBeNull();
    const redirects = await listRedirects();
    expect(redirects).toHaveLength(1);
    expect(redirects[0]?.fromPath).toBe("/about");
    expect(redirects[0]?.toPageId).toBe(created.page.id);
  });

  test("a second rename still resolves both old URLs to the page", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    // The redirect stores the page id, not a URL, which is what makes this work.
    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/company",
      title: "About us",
    });

    const redirects = await listRedirects();
    expect(redirects.map((redirect) => redirect.fromPath).sort()).toEqual([
      "/about",
      "/about-us",
    ]);
    expect(
      redirects.every((redirect) => redirect.toPageId === created.page.id),
    ).toBe(true);
  });

  test("saving without changing the URL writes no redirect", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about",
      title: "About us, really",
    });
    expect(await listRedirects()).toEqual([]);
  });

  test("a page created at a redirected path takes the path back", async () => {
    const first = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!first.ok) throw new Error("create failed");
    await updatePageSettings({
      pageId: first.page.id,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    expect(await listRedirects()).toHaveLength(1);

    const second = await createPage({
      pageType: "landing",
      url: "/about",
      title: "The new about",
    });
    expect(second.ok).toBe(true);
    // The redirect that used to own /about is gone, so the catch-all serves the
    // new page there instead of bouncing to the old one.
    expect(await listRedirects()).toEqual([]);
    expect((await getPageByUrl("/about"))?.title).toBe("The new about");
  });
});
