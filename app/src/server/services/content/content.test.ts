import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import {
  block,
  image,
  link,
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
import { getLatestRevision, saveSlotDraft } from "./index";

const hero = block(
  "hero",
  {
    heading: text({ max: 80 }),
    body: richText(),
    cta: link(),
    gallery: list(image(), { max: 3 }),
  },
  () => null,
);

const document: RichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const validContent = {
  heading: "A heading",
  body: document,
  cta: { type: "url", url: "https://example.com" },
  gallery: [],
};

describe("content write layer", () => {
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

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("saves a valid draft as a revision", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.revision.targetType).toBe("slot");
    expect(result.revision.targetId).toBe(slotId);
    expect(result.revision.content).toEqual(validContent);
    expect(result.revision.createdBy).toBe(editorId);
  });

  test("refuses content that fails the published schema, pointing at the field", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: 5 },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues.some((issue) => issue.path === "heading")).toBe(true);
    expect(await getLatestRevision("slot", slotId)).toBeNull();
  });

  test("keeps a removed field's value and lets it validate (Q4)", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { ...validContent, droppedField: { kept: true } },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.content.droppedField).toEqual({ kept: true });
  });

  test("saves on top of the revision it was based on", async () => {
    const first = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!first.ok) throw new Error("first save failed");

    const second = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Updated" },
      baseRevisionId: first.revision.id,
      actorId: editorId,
    });

    expect(second.ok).toBe(true);
    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.content.heading).toBe("Updated");
  });

  test("refuses to save over a newer revision, naming who saved it and when", async () => {
    const first = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!first.ok) throw new Error("first save failed");

    const otherId = (await seedIdentity(db, "other@example.com")).id;
    const second = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Theirs" },
      baseRevisionId: first.revision.id,
      actorId: otherId,
    });
    if (!second.ok) throw new Error("second save failed");

    // A third editor still holding the first revision.
    const conflicted = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Mine" },
      baseRevisionId: first.revision.id,
      actorId: editorId,
    });

    expect(conflicted.ok).toBe(false);
    if (conflicted.ok || conflicted.reason !== "conflict") return;
    expect(conflicted.newer.revisionId).toBe(second.revision.id);
    expect(conflicted.newer.authorEmail).toBe("other@example.com");

    // And nothing was written on top.
    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.content.heading).toBe("Theirs");
  });

  test("writes once the editor chooses to overwrite", async () => {
    const first = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!first.ok) throw new Error("first save failed");

    await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Theirs" },
      baseRevisionId: first.revision.id,
      actorId: editorId,
    });

    const overwritten = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Mine" },
      baseRevisionId: first.revision.id,
      actorId: editorId,
      overwrite: true,
    });

    expect(overwritten.ok).toBe(true);
    expect((await getLatestRevision("slot", slotId))?.content.heading).toBe(
      "Mine",
    );
  });

  test("throws for a slot that does not exist", async () => {
    await expect(
      saveSlotDraft({
        slotId: "00000000-0000-4000-8000-000000000000",
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      }),
    ).rejects.toThrow(/not found/);
  });
});
