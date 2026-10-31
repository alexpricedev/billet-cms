import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, pageType, text } from "@alexpricedev/billet-cms/fields";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { seedBlockType, seedPageType } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import {
  createPage,
  createRevision,
  getLatestRevision,
  getPageById,
  updatePageSettings,
} from "../../services/content";
import { db } from "../../services/database";
import { jsonbValue } from "../../utils/sql";
import { mcpHandler } from "../index";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "priya@example.com",
  role: "admin",
};

const authInfo: AuthInfo = {
  token: "test",
  clientId: "dev",
  scopes: ["content"],
  extra: { actor, grantId: "test-grant" },
};

const hero = block(
  "hero",
  { label: "Hero" },
  { heading: text({ max: 80 }) },
  () => null,
);
const landing = pageType("landing", { allowedBlocks: [hero] });

/** Call one tool and return its JSON-RPC result. */
const callTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown> }> => {
  const response = await mcpHandler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { authInfo },
  );
  const body = await response.text();
  const payload = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(payload ?? body) as { result?: Record<string, unknown> };
};

describe("save_page", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, hero);
    await seedPageType(db, landing);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  // `cms_pages.url` going back in as the default would read as "revert the
  // move" to the save, silently throwing away an address queued for Publish.
  test("keeps a pending draft URL when the call omits settings", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const revision = await createRevision({
      targetType: "page",
      targetId: created.page.id,
      content: { blocks: [{ type: "hero", heading: "Hi" }] },
      createdBy: null,
    });
    await db`
      UPDATE cms_pages SET published_revision_id = ${revision.id}
      WHERE id = ${created.page.id}
    `;
    const drafted = await updatePageSettings({
      pageId: created.page.id,
      pageType: "landing",
      url: "/studio",
      title: "About us",
    });
    expect(drafted.ok).toBe(true);

    const latest = await getLatestRevision("page", created.page.id);
    const { result } = await callTool("save_page", {
      id: created.page.id,
      baseRevisionId: latest?.id ?? null,
      blocks: [{ type: "hero", heading: "Changed" }],
    });

    expect(result?.isError).toBeUndefined();
    if (!result) throw new Error("save_page returned no result");
    const page = (
      result.structuredContent as {
        page: { url: string; draftUrl: string | null };
      }
    ).page;
    expect(page.url).toBe("/about");
    expect(page.draftUrl).toBe("/studio");

    const stored = await getPageById(created.page.id);
    expect(stored?.url).toBe("/about");
    expect(stored?.draftUrl).toBe("/studio");
  });

  // A social image is a media id, taken from list_media. The tool names a
  // missing upload itself rather than letting the foreign key turn a bad id
  // into a 500, and the write layer refuses it a second time either way.
  test("saves a social image id that names an upload, and refuses one that doesn't", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const revision = await createRevision({
      targetType: "page",
      targetId: created.page.id,
      content: { blocks: [] },
      createdBy: null,
    });

    const mediaRows = (await db`
      INSERT INTO cms_media
        (object_key, content_type, byte_size, width, height, alt, variants)
      VALUES ('media/social/original.webp', 'image/webp', 10, 1200, 630,
              'Social image', ${jsonbValue([])})
      RETURNING id
    `) as { id: string }[];
    const mediaId = mediaRows[0].id;

    const good = await callTool("save_page", {
      id: created.page.id,
      baseRevisionId: revision.id,
      settings: { socialImageId: mediaId },
      blocks: [],
    });
    expect(good.result?.isError).toBeUndefined();
    expect((await getPageById(created.page.id))?.socialImageId).toBe(mediaId);

    const latest = await getLatestRevision("page", created.page.id);
    const bad = await callTool("save_page", {
      id: created.page.id,
      baseRevisionId: latest?.id ?? null,
      settings: { socialImageId: "00000000-0000-4000-8000-000000000099" },
      blocks: [],
    });
    expect(bad.result?.isError).toBe(true);
    expect(JSON.stringify(bad.result)).toContain("No media");
  });
});
