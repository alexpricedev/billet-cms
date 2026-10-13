import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import {
  block,
  image,
  list,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../database";
import {
  createRevision,
  getLatestRevision,
  listSlotHistory,
  publishSlot,
  restoreSlotRevision,
  saveSlotDraft,
} from "./index";
import { getSlotById } from "./slots";

const hero = block(
  "hero",
  {
    heading: text({ max: 80 }),
    body: richText(),
    gallery: list(image(), { max: 3 }),
  },
  () => null,
);

const document: RichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const content = (heading: string) => ({
  heading,
  body: document,
  gallery: [],
});

const contentVersion = async (): Promise<number> => {
  const rows = (await db`
    SELECT content_version FROM cms_meta WHERE id = 1
  `) as { content_version: string }[];
  return Number(rows[0].content_version);
};

describe("publishing", () => {
  let slotId: string;
  let editorId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, hero);
    slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });
    editorId = (await seedIdentity(db, "editor@example.com")).id;
  });

  const draft = async (heading: string, actorId = editorId) => {
    const result = await saveSlotDraft({
      slotId,
      content: content(heading),
      baseRevisionId: (await getLatestRevision("slot", slotId))?.id ?? null,
      actorId,
    });
    if (!result.ok) throw new Error(`draft failed: ${JSON.stringify(result)}`);
    return result.revision;
  };

  test("publishes the newest draft and bumps the content version", async () => {
    const revision = await draft("Live");
    const before = await contentVersion();

    const result = await publishSlot({ slotId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.changed).toBe(true);
    expect(result.revisionId).toBe(revision.id);
    expect(result.contentVersion).toBe(before + 1);

    const slot = await getSlotById(slotId);
    expect(slot?.publishedRevisionId).toBe(revision.id);
  });

  test("leaves a draft unpublished until it is published", async () => {
    await draft("Draft only");

    const slot = await getSlotById(slotId);
    expect(slot?.publishedRevisionId).toBeNull();
  });

  test("re-publishing the same revision is a no-op", async () => {
    await draft("Live");
    await publishSlot({ slotId });
    const after = await contentVersion();

    const again = await publishSlot({ slotId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(await contentVersion()).toBe(after);
  });

  test("publishes an older revision when one is named", async () => {
    const first = await draft("First");
    await draft("Second");

    const result = await publishSlot({ slotId, revisionId: first.id });
    expect(result.ok).toBe(true);

    const slot = await getSlotById(slotId);
    expect(slot?.publishedRevisionId).toBe(first.id);
  });

  test("refuses to publish when there is no draft", async () => {
    const result = await publishSlot({ slotId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-draft");
  });

  // A deploy can change a block under a saved draft. Publishing validates the
  // revision first, so invalid content is stopped here rather than going live
  // and being skipped by the site.
  test("refuses to publish content that no longer validates", async () => {
    // Written directly so the save layer's validation doesn't reject it.
    const invalid = await createRevision({
      targetType: "slot",
      targetId: slotId,
      content: { ...content("Bad"), heading: 7 },
      createdBy: editorId,
    });
    const before = await contentVersion();

    const result = await publishSlot({ slotId });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues.some((issue) => issue.path === "heading")).toBe(true);

    const slot = await getSlotById(slotId);
    expect(slot?.publishedRevisionId).toBeNull();
    expect(await contentVersion()).toBe(before);
    expect(invalid.id).toBeTruthy();
  });

  test("refuses to publish a slot whose block type was removed", async () => {
    await draft("Live");
    await db`UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'`;

    await expect(publishSlot({ slotId })).rejects.toThrow(
      /no longer published/,
    );
  });
});

describe("history and restore", () => {
  let slotId: string;
  let editorId: string;
  let otherId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, hero);
    slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });
    editorId = (await seedIdentity(db, "editor@example.com")).id;
    otherId = (await seedIdentity(db, "other@example.com")).id;
  });

  const draft = async (heading: string, actorId: string) => {
    const result = await saveSlotDraft({
      slotId,
      content: content(heading),
      baseRevisionId: (await getLatestRevision("slot", slotId))?.id ?? null,
      actorId,
    });
    if (!result.ok) throw new Error(`draft failed: ${JSON.stringify(result)}`);
    return result.revision;
  };

  test("lists revisions newest first with author, published and draft marks", async () => {
    const first = await draft("First", editorId);
    const second = await draft("Second", otherId);
    await publishSlot({ slotId, revisionId: first.id });

    const slot = await getSlotById(slotId);
    if (!slot) throw new Error("slot missing");
    const history = await listSlotHistory(slot);

    expect(history.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(history[0].isLatest).toBe(true);
    expect(history[0].isPublished).toBe(false);
    expect(history[0].authorEmail).toBe("other@example.com");
    expect(history[1].isLatest).toBe(false);
    expect(history[1].isPublished).toBe(true);
    expect(history[1].authorEmail).toBe("editor@example.com");
  });

  test("restores an old revision by copying it into a new draft", async () => {
    const first = await draft("First", editorId);
    await draft("Second", editorId);
    await publishSlot({ slotId });

    const result = await restoreSlotRevision({
      slotId,
      revisionId: first.id,
      actorId: otherId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The copy is a new revision, not a rewrite of the one it came from.
    expect(result.revision.id).not.toBe(first.id);
    expect(result.revision.content.heading).toBe("First");
    expect(result.revision.createdBy).toBe(otherId);

    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.id).toBe(result.revision.id);
    expect(latest?.content.heading).toBe("First");

    const rows = (await db`SELECT id FROM cms_revisions`) as { id: string }[];
    expect(rows).toHaveLength(3);

    // Restore is a draft: the published pointer is untouched.
    const slot = await getSlotById(slotId);
    expect(slot?.publishedRevisionId).not.toBe(result.revision.id);
  });

  test("refuses to restore a revision that isn't this slot's", async () => {
    const otherSlotId = await seedSlot(db, {
      name: "home.other",
      blockName: "hero",
      page: "home",
    });
    const otherSlotRevision = await createRevision({
      targetType: "slot",
      targetId: otherSlotId,
      content: content("Elsewhere"),
      createdBy: editorId,
    });

    const result = await restoreSlotRevision({
      slotId,
      revisionId: otherSlotRevision.id,
      actorId: editorId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });
});

afterAll(async () => {
  await connection.end();
  mock.restore();
});
