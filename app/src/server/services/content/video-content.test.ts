/**
 * The CMS's write paths and the video field.
 *
 * A video arrives from a form (or an MCP caller replaying one) as
 * `{ url, title }` and is stored as `{ provider, id, title }`. Every path that
 * validates content has to normalise first, or the schema sees a shape it does
 * not know and the pasted address reaches a revision — the same bug that once
 * left an `image()` inside a `list()` uncollected.
 *
 * The parser's own cases live in the plugin (`fields/video.test.ts`); these
 * tests are about where the CMS calls it: a slot save, a page's blocks, and the
 * two MCP tools that validate and save without a form.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  block,
  blockStoredSchema,
  group,
  list,
  type PageTypeDefinition,
  pageType,
  pageTypeStoredSchema,
  text,
  video,
} from "@alexpricedev/billet-cms/fields";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import { mcpHandler } from "../../mcp";
import { db } from "../database";
import type { BlockTypeRecord, PageTypeRecord } from "./definitions";
import { getLatestRevision, saveSlotDraft } from "./index";
import { validatePageContent } from "./page-content";

const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YOUTUBE_ID = "dQw4w9WgXcQ";
const VIMEO_URL = "https://player.vimeo.com/video/76979871";
const URL_MESSAGE = "Paste a YouTube or Vimeo link.";
const TITLE_MESSAGE = "Add a title for the video.";

const clip = block(
  "clip",
  { label: "Clip" },
  { video: video(), altVideo: video({ required: false }) },
  () => null,
);

const gallery = block(
  "gallery",
  { label: "Gallery" },
  { clips: list(video(), { max: 3 }) },
  () => null,
);

const feature = block(
  "feature",
  { label: "Feature" },
  {
    heading: text({ required: false }),
    media: group({ video: video(), note: text({ required: false }) }),
  },
  () => null,
);

const blockTypeRecord = (
  definition: Parameters<typeof blockStoredSchema>[0],
): BlockTypeRecord => {
  const stored = blockStoredSchema(definition);
  return {
    id: stored.name,
    name: stored.name,
    label: stored.label,
    jsonSchema: stored.jsonSchema,
    fields: stored.fields,
    schemaHash: stored.schemaHash,
    removedAt: null,
  };
};

const pageTypeRecord = (definition: PageTypeDefinition): PageTypeRecord => {
  const stored = pageTypeStoredSchema(definition);
  return {
    id: stored.name,
    name: stored.name,
    label: stored.label ?? null,
    help: stored.help ?? null,
    allowedBlocks: stored.allowedBlocks,
    requiredBlocks: stored.requiredBlocks,
    limits: stored.limits as Record<string, unknown>,
    jsonSchema: stored.jsonSchema,
    removedAt: null,
  };
};

const landing = pageType("landing", { allowedBlocks: [clip] });
const clipType = blockTypeRecord(clip);
const pageBlockTypes = new Map([[clipType.name, clipType]]);

describe("saveSlotDraft and the video field", () => {
  let slotId: string;
  let gallerySlotId: string;
  let featureSlotId: string;
  let editorId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, clip);
    await seedBlockType(db, gallery);
    await seedBlockType(db, feature);
    slotId = await seedSlot(db, {
      name: "home.clip",
      blockName: "clip",
      page: "home",
    });
    gallerySlotId = await seedSlot(db, {
      name: "home.gallery",
      blockName: "gallery",
      page: "home",
    });
    featureSlotId = await seedSlot(db, {
      name: "home.feature",
      blockName: "feature",
      page: "home",
    });
    editorId = (await seedIdentity(db, "editor@example.com")).id;
  });

  test("stores a pasted YouTube link as the provider and id, never the URL", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: {
        video: { url: `${YOUTUBE_URL}&t=42`, title: "  A song  " },
        altVideo: { url: "", title: "" },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.revision.content).toEqual({
      video: { provider: "youtube", id: YOUTUBE_ID, title: "A song" },
    });
    // The optional field the editor left blank is absent, not a stored value
    // with empty parts.
    expect("altVideo" in result.revision.content).toBe(false);
  });

  test("stores a pasted Vimeo player link as the provider and id", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { video: { url: VIMEO_URL, title: "A clip" } },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.content.video).toEqual({
      provider: "vimeo",
      id: "76979871",
      title: "A clip",
    });
  });

  test("refuses a link that is not a YouTube or Vimeo video", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: {
        video: { url: "https://example.com/watch?v=nope", title: "T" },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues).toEqual([
      { path: "video.url", message: URL_MESSAGE },
    ]);
    expect(await getLatestRevision("slot", slotId)).toBeNull();
  });

  test("refuses a video with no title, naming the title box", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { video: { url: YOUTUBE_URL, title: "   " } },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues).toEqual([
      { path: "video.title", message: TITLE_MESSAGE },
    ]);
  });

  // A required video posts while blank so the server can name the box the
  // editor has to fill; the title message would be noise before a link exists.
  test("refuses a required video left blank, naming only the link box", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { video: { url: "", title: "" } },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues).toEqual([
      { path: "video.url", message: URL_MESSAGE },
    ]);
  });

  test("accepts an optional video left blank and stores nothing for it", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: {
        video: { url: YOUTUBE_URL, title: "A song" },
        altVideo: { url: "", title: "" },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.content).toEqual({
      video: { provider: "youtube", id: YOUTUBE_ID, title: "A song" },
    });
  });

  test("normalises a video inside a list item and points a refusal at its row", async () => {
    const saved = await saveSlotDraft({
      slotId: gallerySlotId,
      content: {
        clips: [
          { url: YOUTUBE_URL, title: "One" },
          { url: VIMEO_URL, title: "Two" },
        ],
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.revision.content.clips).toEqual([
      { provider: "youtube", id: YOUTUBE_ID, title: "One" },
      { provider: "vimeo", id: "76979871", title: "Two" },
    ]);

    const refused = await saveSlotDraft({
      slotId: gallerySlotId,
      content: {
        clips: [
          { url: YOUTUBE_URL, title: "One" },
          { url: "https://vimeo.com/not-a-number", title: "Two" },
        ],
      },
      baseRevisionId: saved.revision.id,
      actorId: editorId,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "invalid") return;
    expect(refused.issues).toEqual([
      { path: "clips.1.url", message: URL_MESSAGE },
    ]);
  });

  test("normalises a video inside a group and points a refusal at its path", async () => {
    const saved = await saveSlotDraft({
      slotId: featureSlotId,
      content: {
        heading: "Feature",
        media: { video: { url: YOUTUBE_URL, title: "One" } },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.revision.content.media).toEqual({
      video: { provider: "youtube", id: YOUTUBE_ID, title: "One" },
    });

    const refused = await saveSlotDraft({
      slotId: featureSlotId,
      content: {
        heading: "Feature",
        media: { video: { url: "javascript:alert(1)", title: "One" } },
      },
      baseRevisionId: saved.revision.id,
      actorId: editorId,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "invalid") return;
    expect(refused.issues).toEqual([
      { path: "media.video.url", message: URL_MESSAGE },
    ]);
  });

  // A save of content that already holds the stored shape must leave it alone:
  // the form posts it back unchanged with JavaScript off, and the site's own
  // publish path validates stored revisions.
  test("leaves an already-stored video unchanged", async () => {
    const stored = { provider: "youtube", id: YOUTUBE_ID, title: "A song" };
    const result = await saveSlotDraft({
      slotId,
      content: { video: stored },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.content.video).toEqual(stored);
  });

  test("still refuses a hand-written id that tries to smuggle a path", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: {
        video: { provider: "youtube", id: "../evil", title: "A song" },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues[0]?.path).toBe("video.id");
  });
});

describe("validatePageContent and the video field", () => {
  test("returns the stored shape for a page block's pasted link", () => {
    const result = validatePageContent(
      pageTypeRecord(landing),
      pageBlockTypes,
      {
        blocks: [
          { type: "clip", video: { url: YOUTUBE_URL, title: "A song" } },
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.blocks[0]?.video).toEqual({
      provider: "youtube",
      id: YOUTUBE_ID,
      title: "A song",
    });
  });

  test("refuses a page block's bad link on the block's field path", () => {
    const result = validatePageContent(
      pageTypeRecord(landing),
      pageBlockTypes,
      {
        blocks: [
          {
            type: "clip",
            video: { url: "https://example.com", title: "A song" },
          },
        ],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: "blocks.0.video.url", message: URL_MESSAGE },
    ]);
  });
});

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

/** Call one MCP tool and return its JSON-RPC result. */
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

describe("the MCP write tools and the video field", () => {
  let slotId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, clip);
    slotId = await seedSlot(db, {
      name: "home.clip",
      blockName: "clip",
      page: "home",
    });
  });

  test("validate_slot accepts a pasted link and refuses a bad one on its box", async () => {
    const good = await callTool("validate_slot", {
      slot: "home.clip",
      content: { video: { url: YOUTUBE_URL, title: "A song" } },
    });
    expect(good.result?.isError).toBeUndefined();

    const bad = await callTool("validate_slot", {
      slot: "home.clip",
      content: { video: { url: "https://example.com", title: "A song" } },
    });
    expect(bad.result?.isError).toBe(true);
    expect(JSON.stringify(bad.result)).toContain(URL_MESSAGE);
    expect(JSON.stringify(bad.result)).toContain("video.url");
  });

  test("save_slot stores the parsed value, and a retry with the raw link is unchanged", async () => {
    const content = { video: { url: YOUTUBE_URL, title: "A song" } };
    const first = await callTool("save_slot", {
      slot: "home.clip",
      baseRevisionId: null,
      content,
    });
    expect(first.result?.isError).toBeUndefined();
    if (!first.result) throw new Error("save_slot returned no result");
    const { revisionId } = first.result.structuredContent as {
      revisionId: string;
    };

    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.content.video).toEqual({
      provider: "youtube",
      id: YOUTUBE_ID,
      title: "A song",
    });

    const retry = await callTool("save_slot", {
      slot: "home.clip",
      baseRevisionId: revisionId,
      content,
    });
    if (!retry.result) throw new Error("save_slot returned no result");
    expect(
      (retry.result.structuredContent as { unchanged: boolean }).unchanged,
    ).toBe(true);
  });
});

// One connection for the whole file: the MCP tools reach the same mocked pool,
// so it must stay open across every describe.
afterAll(async () => {
  await connection.end();
  mock.restore();
});
