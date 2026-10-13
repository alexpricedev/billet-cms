import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  block,
  pageType,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import {
  createCmsPageRoute,
  createCmsPages,
} from "@alexpricedev/billet-cms/server";
import { seedBlockType, seedPageType } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import {
  createPage,
  getLatestRevision,
  getPageById,
  listPageHistory,
  publishPage,
  restorePageRevision,
  savePageDraft,
  updatePageSettings,
} from "./index";

const hero = block(
  "hero",
  { heading: text({ max: 80 }), body: richText() },
  () => null,
);

const document = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

const landing = pageType("landing", {
  allowedBlocks: [hero],
  requiredBlocks: [hero],
  limits: { hero: { max: 1, position: "top" } },
});

const content = (heading: string) => ({
  blocks: [{ type: "hero", heading, body: document }],
});

describe("the site reading a published page", () => {
  let pageId: string;
  let editorId: string;
  let now: number;

  beforeEach(async () => {
    await cleanupTestData(connection);
    await seedBlockType(connection, hero);
    await seedPageType(connection, landing);
    editorId = (await seedIdentity(connection, "editor@example.com")).id;
    now = 0;

    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
      seoDescription: "Who we are.",
    });
    if (!created.ok) throw new Error("page create failed");
    pageId = created.page.id;
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const reader = (onSkip: (message: string) => void = () => {}) =>
    createCmsPages({ sql: connection, now: () => now, onSkip });

  /** Save a draft, publish it, and step the injected clock past the interval. */
  const publish = async (heading: string) => {
    const latest = await getLatestRevision("page", pageId);
    const saved = await savePageDraft({
      pageId,
      content: content(heading),
      baseRevisionId: latest?.id ?? null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error(`save failed: ${JSON.stringify(saved)}`);
    const published = await publishPage({ pageId });
    if (!published.ok) throw new Error("publish failed");
    now += 1000;
  };

  test("serves a published page with its validated blocks", async () => {
    await publish("Hello");

    const page = await reader().getPage("/about");
    expect(page?.title).toBe("About us");
    expect(page?.seoDescription).toBe("Who we are.");
    expect(page?.blocks).toHaveLength(1);
    expect(page?.blocks[0]?.heading).toBe("Hello");
  });

  test("returns nothing while the page is only a draft", async () => {
    await savePageDraft({
      pageId,
      content: content("Draft"),
      baseRevisionId: null,
      actorId: editorId,
    });
    now += 1000;

    expect(await reader().getPage("/about")).toBeNull();
    // And a draft never reaches the sitemap.
    expect(await reader().listSitemapEntries()).toEqual([]);
  });

  test("a rename leaves a working 301 and the page's links intact", async () => {
    await publish("Hello");

    const before = await reader().resolveLink({ type: "page", pageId });
    expect(before).toBe("/about");

    const renamed = await updatePageSettings({
      pageId,
      pageType: "landing",
      url: "/about-us",
      title: "About us",
    });
    expect(renamed.ok).toBe(true);
    now += 1000;

    // The old path answers with the page's current URL...
    const redirect = await reader().getRedirect("/about");
    expect(redirect).toBe("/about-us");
    // ...and the link stored by page id follows the rename with no rewrite.
    expect(await reader().resolveLink({ type: "page", pageId })).toBe(
      "/about-us",
    );
    // The page moved, so the new path is what serves.
    expect(await reader().getPage("/about")).toBeNull();
    expect((await reader().getPage("/about-us"))?.title).toBe("About us");
  });

  test("lists published pages as sitemap entries", async () => {
    await publish("Hello");

    const entries = await reader().listSitemapEntries();
    expect(entries.map((entry) => entry.url)).toEqual(["/about"]);
    expect(entries[0]?.lastModified).toBeInstanceOf(Date);
  });

  test("the catch-all redirects, then serves the page, then yields to the 404", async () => {
    await publish("Hello");

    const route = createCmsPageRoute({
      sql: connection,
      render: (page) =>
        new Response(`<h1>${page.title}</h1>`, {
          headers: { "Content-Type": "text/html" },
        }),
      now: () => now,
      onSkip: () => {},
    });

    const served = await route(new Request("http://localhost/about"));
    expect(served?.status).toBe(200);
    expect(await served?.text()).toContain("<h1>About us</h1>");

    expect(await route(new Request("http://localhost/missing"))).toBeNull();

    await updatePageSettings({
      pageId,
      pageType: "landing",
      url: "/company",
      title: "About us",
    });
    now += 1000;

    const moved = await route(new Request("http://localhost/about"));
    expect(moved?.status).toBe(301);
    expect(moved?.headers.get("Location")).toBe("/company");
  });

  test("restores an old revision into a new draft", async () => {
    await publish("First");
    await publish("Second");

    const page = await getPageById(pageId);
    if (!page) throw new Error("page missing");
    const history = await listPageHistory(page);
    const oldest = history[history.length - 1];
    if (!oldest) throw new Error("no history");

    const restored = await restorePageRevision({
      pageId,
      revisionId: oldest.id,
      actorId: editorId,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    const latest = await listPageHistory(page);
    expect(latest[0]?.isPublished).toBe(false);
    expect(latest[0]?.id).toBe(restored.revision.id);
  });

  test("skips a page whose block type a deploy removed, and logs it", async () => {
    await publish("Hello");
    await connection`
      UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'
    `;
    now += 1000;

    const skipped: string[] = [];
    const page = await reader((message) => skipped.push(message)).getPage(
      "/about",
    );

    // The page still resolves; the block that is gone is dropped with a line.
    expect(page?.blocks).toEqual([]);
    expect(skipped.some((line) => line.includes("removed by a deploy"))).toBe(
      true,
    );
  });
});
