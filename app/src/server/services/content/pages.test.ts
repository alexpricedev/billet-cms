import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  applyDraftUrl,
  createPage,
  deletePage,
  getPageById,
  getPageByUrl,
  getPageUsage,
  listPageOptions,
  listPages,
  listRedirects,
  normalisePageUrl,
  updatePageSettings,
} from "./pages";
import { createRevision } from "./revisions";

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

  test("refuses a backslash, which a browser reads as a slash", () => {
    expect(normalisePageUrl("/\\evil.example").ok).toBe(false);
    expect(normalisePageUrl("\\evil.example").ok).toBe(false);
  });

  test("resolves dot segments and percent-encodes non-ASCII", () => {
    // `/a/../b` is `/b`, and `url.pathname` is what the catch-all compares.
    expect(normalisePageUrl("/a/../b")).toEqual({ ok: true, url: "/b" });
    expect(normalisePageUrl("/café")).toEqual({ ok: true, url: "/caf%C3%A9" });
    expect(normalisePageUrl("/caf%C3%A9")).toEqual({
      ok: true,
      url: "/caf%C3%A9",
    });
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

  // Part 9: the message names the page that holds the URL, so the editor knows
  // which one to go and change.
  test("refuses a second page on the same URL, naming the page that has it", async () => {
    await create("/about", "About Northwind");
    const again = await create("about/");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.issues[0]?.path).toBe("url");
    expect(again.issues[0]?.message).toBe(
      "About Northwind already uses /about.",
    );
  });

  test("names the page that has the URL when a rename collides", async () => {
    const about = await create("/about", "About Northwind");
    const team = await create("/team", "Team");
    if (!about.ok || !team.ok) throw new Error("create failed");

    const result = await updatePageSettings({
      pageId: team.page.id,
      pageType: "landing",
      url: "/about",
      title: "Team",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toBe(
      "About Northwind already uses /about.",
    );
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

  test("refuses a social image that isn't an http(s) URL or a path", async () => {
    const result = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
      socialImage: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("socialImage");
    expect(await listPages()).toEqual([]);
  });

  test("accepts an absolute or site-relative social image", async () => {
    // The `create` helper uses `/og/about.png`.
    expect((await create("/relative")).ok).toBe(true);
    const absolute = await createPage({
      pageType: "landing",
      url: "/absolute",
      title: "Absolute",
      socialImage: "https://cdn.example/og.png",
    });
    expect(absolute.ok).toBe(true);
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

  test("skips the write and the version bump when the settings didn't change", async () => {
    const created = await create("/about");
    if (!created.ok) throw new Error("create failed");

    const version = async (): Promise<number> =>
      Number(
        (await db`SELECT content_version FROM cms_meta WHERE id = 1`)[0]
          .content_version,
      );
    const before = await version();

    // The `create` helper's own settings, saved back unchanged.
    const same = await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about",
      title: "About us",
      seoDescription: "Who we are.",
      socialImage: "/og/about.png",
    });
    expect(same.ok).toBe(true);
    expect(await version()).toBe(before);

    const changed = await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about",
      title: "A new title",
    });
    expect(changed.ok).toBe(true);
    expect(await version()).toBe(before + 1);
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

describe("getPageUsage", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedPageType(db, landing);
  });

  test("counts the redirects pointing here and names the pages linking here", async () => {
    const target = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!target.ok) throw new Error("create failed");
    const other = await createPage({
      pageType: "landing",
      url: "/other",
      title: "Other",
    });
    if (!other.ok) throw new Error("create failed");

    await db`
      INSERT INTO cms_redirects (id, from_path, to_page_id)
      VALUES (${randomUUID()}, '/old-about', ${target.page.id})
    `;
    // A page-mode link stored by page id, the way a `link()` field writes one.
    await createRevision({
      targetType: "page",
      targetId: other.page.id,
      content: {
        blocks: [
          {
            type: "hero",
            heading: "Go",
            cta: { type: "page", pageId: target.page.id },
          },
        ],
      },
      createdBy: null,
    });

    const usage = await getPageUsage(target.page.id);
    expect(usage.redirectCount).toBe(1);
    expect(usage.linkingPages.map((page) => page.title)).toEqual(["Other"]);
  });

  test("reports nothing for a page nothing points at", async () => {
    const page = await createPage({
      pageType: "landing",
      url: "/lonely",
      title: "Lonely",
    });
    if (!page.ok) throw new Error("create failed");

    expect(await getPageUsage(page.page.id)).toEqual({
      redirectCount: 0,
      linkingPages: [],
    });
  });

  test("a free URL link to the same path is not a page link", async () => {
    const target = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!target.ok) throw new Error("create failed");
    const other = await createPage({
      pageType: "landing",
      url: "/other",
      title: "Other",
    });
    if (!other.ok) throw new Error("create failed");

    await createRevision({
      targetType: "page",
      targetId: other.page.id,
      content: {
        blocks: [{ type: "hero", cta: { type: "url", url: "/about" } }],
      },
      createdBy: null,
    });

    expect((await getPageUsage(target.page.id)).linkingPages).toEqual([]);
  });
});

describe("a URL change waits for Publish", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedPageType(db, landing);
  });

  /** Create a page and give it a published revision, so it has a live URL. */
  const createPublished = async (
    url: string,
    title = "About us",
  ): Promise<{ id: string }> => {
    const created = await createPage({ pageType: "landing", url, title });
    if (!created.ok) throw new Error("create failed");
    const revision = await createRevision({
      targetType: "page",
      targetId: created.page.id,
      content: { blocks: [] },
      createdBy: null,
    });
    await db`
      UPDATE cms_pages SET published_revision_id = ${revision.id}
      WHERE id = ${created.page.id}
    `;
    return created.page;
  };

  const contentVersion = async (): Promise<number> =>
    Number(
      (await db`SELECT content_version FROM cms_meta WHERE id = 1`)[0]
        .content_version,
    );

  test("saving a new URL on a published page drafts it and changes nothing live", async () => {
    const page = await createPublished("/about");
    const version = await contentVersion();

    const saved = await updatePageSettings({
      pageId: page.id,
      pageType: "landing",
      url: "/studio",
      title: "About us",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // The editor reads the draft from the record; the live row is untouched.
    expect(saved.page.url).toBe("/about");
    expect(saved.page.draftUrl).toBe("/studio");
    expect((await getPageById(page.id))?.url).toBe("/about");
    expect((await getPageById(page.id))?.draftUrl).toBe("/studio");

    // Nothing the site can see moved: no redirect, no new address, no bump.
    expect(await getPageByUrl("/studio")).toBeNull();
    expect(await getPageByUrl("/about")).not.toBeNull();
    expect(await listRedirects()).toEqual([]);
    expect(await contentVersion()).toBe(version);
  });

  test("typing the live URL back clears a pending change", async () => {
    const page = await createPublished("/about");

    await updatePageSettings({
      pageId: page.id,
      pageType: "landing",
      url: "/studio",
      title: "About us",
    });
    expect((await getPageById(page.id))?.draftUrl).toBe("/studio");

    const reverted = await updatePageSettings({
      pageId: page.id,
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    expect(reverted.page.url).toBe("/about");
    expect(reverted.page.draftUrl).toBeNull();
  });

  test("a title change still goes live while the URL waits", async () => {
    const page = await createPublished("/about");
    const version = await contentVersion();

    const saved = await updatePageSettings({
      pageId: page.id,
      pageType: "landing",
      url: "/studio",
      title: "Our studio",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.page.title).toBe("Our studio");
    expect(saved.page.draftUrl).toBe("/studio");
    // A title is live with the save, so the site's cache must drop.
    expect(await contentVersion()).toBe(version + 1);
  });

  test("a never-published page still moves immediately", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    const renamed = await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/studio",
      title: "About us",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.page.url).toBe("/studio");
    expect(renamed.page.draftUrl).toBeNull();
    expect((await listRedirects()).map((r) => r.fromPath)).toEqual(["/about"]);
  });

  test("refuses a draft URL another page already uses live", async () => {
    const about = await createPublished("/about", "About Northwind");
    await createPublished("/studio", "Studio");

    const result = await updatePageSettings({
      pageId: about.id,
      pageType: "landing",
      url: "/studio",
      title: "About Northwind",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("url");
    expect(result.issues[0]?.message).toBe("Studio already uses /studio.");
  });

  test("refuses a draft URL another page holds as a draft", async () => {
    const about = await createPublished("/about", "About Northwind");
    const studio = await createPublished("/studio", "Studio");

    // Studio's pending move reserves /work before it is live.
    await updatePageSettings({
      pageId: studio.id,
      pageType: "landing",
      url: "/work",
      title: "Studio",
    });

    const result = await updatePageSettings({
      pageId: about.id,
      pageType: "landing",
      url: "/work",
      title: "About Northwind",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toBe("Studio already uses /work.");
  });
});

describe("applyDraftUrl", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedPageType(db, landing);
  });

  const createPublished = async (url: string, title = "About us") => {
    const created = await createPage({ pageType: "landing", url, title });
    if (!created.ok) throw new Error("create failed");
    const revision = await createRevision({
      targetType: "page",
      targetId: created.page.id,
      content: { blocks: [] },
      createdBy: null,
    });
    await db`
      UPDATE cms_pages SET published_revision_id = ${revision.id}
      WHERE id = ${created.page.id}
    `;
    return created.page;
  };

  const draft = async (pageId: string, url: string) => {
    const result = await updatePageSettings({
      pageId,
      pageType: "landing",
      url,
      title: "About us",
    });
    if (!result.ok) throw new Error("draft save failed");
  };

  test("moves the page, writes the redirect and clears the draft", async () => {
    const page = await createPublished("/about");
    await draft(page.id, "/studio");

    const moved = await db.begin((tx) => applyDraftUrl(tx, page.id));
    expect(moved).toEqual({ from: "/about", to: "/studio" });

    const stored = await getPageById(page.id);
    expect(stored?.url).toBe("/studio");
    expect(stored?.draftUrl).toBeNull();
    expect(await getPageByUrl("/about")).toBeNull();
    const redirects = await listRedirects();
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toMatchObject({
      fromPath: "/about",
      toPageId: page.id,
    });
  });

  test("does nothing when no URL is pending", async () => {
    const page = await createPublished("/about");
    expect(await db.begin((tx) => applyDraftUrl(tx, page.id))).toBeNull();
    expect(await listRedirects()).toEqual([]);
  });

  test("refuses a URL another page took after the draft was saved", async () => {
    const page = await createPublished("/about", "About Northwind");
    await draft(page.id, "/studio");

    // The race the save-time check can't close: another page gets the address
    // before the first page is published.
    const other = await createPage({
      pageType: "landing",
      url: "/other",
      title: "Other",
    });
    if (!other.ok) throw new Error("create failed");
    await db`UPDATE cms_pages SET url = '/studio' WHERE id = ${other.page.id}`;

    await expect(db.begin((tx) => applyDraftUrl(tx, page.id))).rejects.toThrow(
      "Other already uses /studio.",
    );

    // The refused publish left everything as it was.
    const stored = await getPageById(page.id);
    expect(stored?.url).toBe("/about");
    expect(stored?.draftUrl).toBe("/studio");
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

  test("renaming back to an earlier URL takes it back from its own redirect", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/about",
      title: "About us",
    });

    // The page is at /about again, and /about is no longer a redirect.
    expect((await getPageByUrl("/about"))?.title).toBe("About us");
    expect(await getPageByUrl("/about-us")).toBeNull();
    const redirects = await listRedirects();
    expect(redirects.map((redirect) => redirect.fromPath)).toEqual([
      "/about-us",
    ]);
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
