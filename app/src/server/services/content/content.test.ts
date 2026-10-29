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
import { createRevision } from "./revisions";

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
  cta: { type: "url", url: "https://example.com", label: "Go" },
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

  // Q4: the value is re-attached from the revision the editor loaded, so the
  // client never has to send a key the schema no longer declares.
  test("carries a removed field through from the revision it was based on", async () => {
    // A revision written while the field still existed. Written directly so the
    // strict validator doesn't reject the very key under test.
    const seeded = await createRevision({
      targetType: "slot",
      targetId: slotId,
      content: { ...validContent, droppedField: { kept: true } },
      createdBy: editorId,
    });

    const result = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: seeded.id,
      actorId: editorId,
    });

    expect(result.ok).toBe(true);
    const latest = await getLatestRevision("slot", slotId);
    expect(latest?.content.droppedField).toEqual({ kept: true });
  });

  test("refuses a key the schema does not declare", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { ...validContent, nope: 1 },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    // Zod reports an unrecognised key at the root, naming it in the message.
    expect(result.issues.some((issue) => issue.message.includes("nope"))).toBe(
      true,
    );
  });

  // The form is read-only once a deploy removes the block type (Q4); the write
  // layer refuses the slot too rather than trusting every caller to check.
  test("refuses to save a slot whose block type was removed", async () => {
    await db`UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'`;

    await expect(
      saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      }),
    ).rejects.toThrow(/no longer published/);
  });

  // The form shows the validator's message beside the field's label, so the
  // write layer turns Zod's jargon into copy an editor can act on (item 9).
  test("maps a schema failure to plain copy", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "x".repeat(81) },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    const heading = result.issues.find((issue) => issue.path === "heading");
    expect(heading?.message).toBe("Use 80 characters or fewer.");
  });

  // The link's allowlist reaches the editor as a JSON Schema `pattern`, which
  // Zod reports only as "must match pattern <source>". The write layer names the
  // link with the same copy the site-side schema uses, rather than a generic
  // "expected format" that hides what a usable link looks like.
  test("names a link that fails the allowlist with its own copy", async () => {
    const result = await saveSlotDraft({
      slotId,
      content: {
        ...validContent,
        cta: { type: "url", url: "javascript:alert(1)" },
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(
      result.issues.some(
        (issue) => issue.message === "Enter a full URL, starting with https://",
      ),
      JSON.stringify(result.issues),
    ).toBe(true);
  });

  test("names a missing required field in plain copy", async () => {
    const { heading: _omitted, ...withoutHeading } = validContent;
    const result = await saveSlotDraft({
      slotId,
      content: withoutHeading,
      baseRevisionId: null,
      actorId: editorId,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    const heading = result.issues.find((issue) => issue.path === "heading");
    expect(heading?.message).toBe("This field is required.");
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

  // Item 15: the overwrite is not a flag that skips the check — it is a base
  // pointing at the revision the editor has now seen.
  test("writes when the base is the conflicted newer revision", async () => {
    const first = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!first.ok) throw new Error("first save failed");

    const second = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Theirs" },
      baseRevisionId: first.revision.id,
      actorId: editorId,
    });
    if (!second.ok) throw new Error("second save failed");

    const overwritten = await saveSlotDraft({
      slotId,
      content: { ...validContent, heading: "Mine" },
      baseRevisionId: second.revision.id,
      actorId: editorId,
    });

    expect(overwritten.ok).toBe(true);
    expect((await getLatestRevision("slot", slotId))?.content.heading).toBe(
      "Mine",
    );
  });

  // Item 2/21: the conflict check and the insert are one transaction under a
  // row lock, so a first save raced by a second produces a conflict, not two
  // drafts written as though each was current.
  test("serialises two first saves: one wins, one conflicts", async () => {
    const [a, b] = await Promise.all([
      saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "A" },
        baseRevisionId: null,
        actorId: editorId,
      }),
      saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "B" },
        baseRevisionId: null,
        actorId: editorId,
      }),
    ]);

    const results = [a, b];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    const revisions = await db`SELECT id FROM cms_revisions`;
    expect(revisions).toHaveLength(1);
  });

  test("serialises two saves based on the same revision", async () => {
    const first = await saveSlotDraft({
      slotId,
      content: validContent,
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!first.ok) throw new Error("first save failed");

    const [a, b] = await Promise.all([
      saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "A" },
        baseRevisionId: first.revision.id,
        actorId: editorId,
      }),
      saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "B" },
        baseRevisionId: first.revision.id,
        actorId: editorId,
      }),
    ]);

    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    const revisions = await db`SELECT id FROM cms_revisions`;
    expect(revisions).toHaveLength(2);
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
