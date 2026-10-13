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
  createContentReader,
  hashPreviewToken,
  readPreviewAccess,
} from "@alexpricedev/billet-cms/server";
import {
  seedBlockType,
  seedPageType,
  seedSlot,
} from "../../test-utils/content";
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
  publishPage,
  publishSlot,
  savePageDraft,
  saveSlotDraft,
} from "./index";
import { buildPreviewUrl, createPreviewToken } from "./preview";

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

const pageContent = (heading: string) => ({
  blocks: [{ type: "hero", heading, body: document }],
});

const slotContent = (heading: string) => ({ heading, body: document });

const HOUR = 60 * 60 * 1000;

describe("preview tokens", () => {
  let editorId: string;
  let slotId: string;
  let pageId: string;

  beforeEach(async () => {
    await cleanupTestData(connection);
    await seedBlockType(connection, hero);
    await seedPageType(connection, landing);
    slotId = await seedSlot(connection, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
      previewPath: "/",
    });
    editorId = (await seedIdentity(connection, "editor@example.com")).id;

    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("page create failed");
    pageId = created.page.id;
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("mints a token: hashed at rest, half an hour long, one subject", async () => {
    const now = new Date("2026-10-13T09:00:00.000Z");
    const { rawToken, expiresAt } = await createPreviewToken({
      subjectType: "page",
      subjectId: pageId,
      createdBy: editorId,
      now,
    });

    expect(expiresAt.getTime() - now.getTime()).toBe(30 * 60 * 1000);

    const rows = (await connection`
      SELECT subject_type, subject_id, token_hash, created_by
      FROM cms_preview_tokens
    `) as {
      subject_type: string;
      subject_id: string;
      token_hash: string;
      created_by: string;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].subject_type).toBe("page");
    expect(rows[0].subject_id).toBe(pageId);
    expect(rows[0].created_by).toBe(editorId);
    // The raw token is nowhere in the row: only its hash is stored.
    expect(rows[0].token_hash).toBe(hashPreviewToken(rawToken));
    expect(rows[0].token_hash).not.toBe(rawToken);

    // And the raw token resolves back to the subject.
    expect(await readPreviewAccess(connection, rawToken, now)).toEqual({
      subjectType: "page",
      subjectId: pageId,
    });
  });

  test("an expired token resolves to nothing; a wrong one too", async () => {
    const longAgo = new Date(Date.now() - 2 * HOUR);
    const { rawToken } = await createPreviewToken({
      subjectType: "slot",
      subjectId: slotId,
      createdBy: editorId,
      now: longAgo,
    });

    expect(await readPreviewAccess(connection, rawToken)).toBeNull();
    expect(await readPreviewAccess(connection, "not-a-token")).toBeNull();
  });

  test("builds a same-origin preview URL and refuses off-site paths", () => {
    const url = buildPreviewUrl({
      baseUrl: "https://example.com/",
      path: "/about",
      rawToken: "tok",
    });
    expect(url).toBe("https://example.com/about?cms_preview=tok");

    // An off-site path falls back to the site root rather than navigating away.
    expect(
      buildPreviewUrl({
        baseUrl: "https://example.com",
        path: "//evil.example/phish",
        rawToken: "tok",
      }),
    ).toBe("https://example.com/?cms_preview=tok");

    // No configured site: there is nowhere to open.
    expect(
      buildPreviewUrl({ baseUrl: "", path: "/about", rawToken: "tok" }),
    ).toBeNull();
  });

  test("a page token renders the draft, a bad token the published page", async () => {
    // Publish one revision, then save a newer draft on top.
    const saved = await savePageDraft({
      pageId,
      content: pageContent("Published"),
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error("save failed");
    const published = await publishPage({ pageId });
    if (!published.ok) throw new Error("publish failed");
    const draft = await savePageDraft({
      pageId,
      content: pageContent("Draft"),
      baseRevisionId: (await getLatestRevision("page", pageId))?.id ?? null,
      actorId: editorId,
    });
    if (!draft.ok) throw new Error("draft save failed");

    const pages = createCmsPages({ sql: connection, onSkip: () => {} });
    expect((await pages.getPage("/about"))?.blocks[0]?.heading).toBe(
      "Published",
    );
    expect(
      (
        await pages.getPage("/about", {
          preview: { subjectType: "page", subjectId: pageId },
        })
      )?.blocks[0]?.heading,
    ).toBe("Draft");

    // The catch-all end to end: the banner, the headers and the draft body.
    const route = createCmsPageRoute({
      sql: connection,
      render: (page) =>
        new Response(
          `<html><body><p>${String(page.blocks[0]?.heading)}</p></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      onSkip: () => {},
    });

    const { rawToken } = await createPreviewToken({
      subjectType: "page",
      subjectId: pageId,
      createdBy: editorId,
    });

    const preview = await route(
      new Request(`http://site.test/about?cms_preview=${rawToken}`),
    );
    expect(preview?.headers.get("Cache-Control")).toBe("no-store");
    expect(preview?.headers.get("X-Robots-Tag")).toBe("noindex");
    const html = await preview?.text();
    expect(html).toContain("<p>Draft</p>");
    expect(html).toContain("cms-preview-banner");

    // A wrong token is the published view, with no preview headers.
    const live = await route(
      new Request("http://site.test/about?cms_preview=wrong"),
    );
    expect(live?.headers.get("Cache-Control")).not.toBe("no-store");
    const liveHtml = await live?.text();
    expect(liveHtml).toContain("<p>Published</p>");
    expect(liveHtml).not.toContain("cms-preview-banner");
  });

  test("a slot token renders that slot's draft inside the app page", async () => {
    const saved = await saveSlotDraft({
      slotId,
      content: slotContent("Published hero"),
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error("slot save failed");
    const published = await publishSlot({ slotId });
    if (!published.ok) throw new Error("slot publish failed");
    const draft = await saveSlotDraft({
      slotId,
      content: slotContent("Draft hero"),
      baseRevisionId: (await getLatestRevision("slot", slotId))?.id ?? null,
      actorId: editorId,
    });
    if (!draft.ok) throw new Error("slot draft save failed");

    const reader = createContentReader({ sql: connection, onSkip: () => {} });

    expect((await reader.getSlot("home.hero"))?.heading).toBe("Published hero");
    expect(
      (
        await reader.getSlot("home.hero", {
          preview: { subjectType: "slot", subjectId: slotId },
        })
      )?.heading,
    ).toBe("Draft hero");
  });
});
