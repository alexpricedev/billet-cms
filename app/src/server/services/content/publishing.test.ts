import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { jsonbValue } from "../../utils/sql";

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
  HISTORY_PAGE_SIZE,
  listSlotHistory,
  publishSlot,
  restoreSlotRevision,
  saveSlotDraft,
} from "./index";
import { getSlotById } from "./slots";

const hero = block(
  "hero",
  { label: "Hero" },
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

  // The form names the revision it rendered and asks for the newest too: if a
  // colleague saved after that, the publish is refused rather than going live.
  test("refuses a named revision that is no longer the newest", async () => {
    const first = await draft("First");
    await draft("Second");

    const result = await publishSlot({
      slotId,
      revisionId: first.id,
      requireLatest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "stale") return;
    expect((await getSlotById(slotId))?.publishedRevisionId).toBeNull();
  });

  // Two publishes racing on one slot both take the row lock, so the pointer
  // write and the version bump can't interleave; the second is a no-op.
  test("serialise concurrent publishes of the same slot", async () => {
    const revision = await draft("Live");
    const before = await contentVersion();

    const [a, b] = await Promise.all([
      publishSlot({ slotId }),
      publishSlot({ slotId }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.revisionId).toBe(revision.id);
    expect(b.revisionId).toBe(revision.id);
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
    expect(await contentVersion()).toBe(before + 1);
    expect((await getSlotById(slotId))?.publishedRevisionId).toBe(revision.id);
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

  // Button text is an authoring rule, and a revision written before the rule
  // existed can carry a filled link with no label. A save would refuse it now,
  // but re-running the rule at publish would strand content the site already
  // renders — so publish checks the schema only.
  test("publishes stored content written before the button-text rule", async () => {
    const legacy = block(
      "legacy-cta",
      { label: "Legacy CTA" },
      { cta: link() },
      () => null,
    );
    await seedBlockType(db, legacy);
    const legacySlot = await seedSlot(db, {
      name: "home.legacy-cta",
      blockName: "legacy-cta",
      page: "home",
    });
    const revision = await createRevision({
      targetType: "slot",
      targetId: legacySlot,
      content: { cta: { type: "url", url: "https://example.com" } },
      createdBy: editorId,
    });

    const result = await publishSlot({ slotId: legacySlot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revisionId).toBe(revision.id);
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
    const { revisions: history } = await listSlotHistory(slot);

    expect(history.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(history[0].isLatest).toBe(true);
    expect(history[0].isPublished).toBe(false);
    expect(history[0].authorEmail).toBe("other@example.com");
    expect(history[1].isLatest).toBe(false);
    expect(history[1].isPublished).toBe(true);
    expect(history[1].authorEmail).toBe("editor@example.com");
  });

  // Part 5. After a restore-then-publish the newest revision is live, so it is
  // not a draft any more — and the row the editor would load is the live one,
  // not some older revision that merely looks like it (the copy is identical
  // and saved in the same minute as its source).
  test("stops calling the newest revision the draft once it is published", async () => {
    const first = await draft("First", editorId);
    const second = await draft("Second", editorId);
    const restored = await restoreSlotRevision({
      slotId,
      revisionId: first.id,
      actorId: editorId,
    });
    if (!restored.ok) throw new Error("restore failed");
    await publishSlot({ slotId, revisionId: restored.revision.id });

    const slot = await getSlotById(slotId);
    if (!slot) throw new Error("slot missing");
    const { revisions: history } = await listSlotHistory(slot);

    expect(history.map((entry) => entry.id)).toEqual([
      restored.revision.id,
      second.id,
      first.id,
    ]);
    // The live row is newest and published; nothing is offered as the draft.
    expect(history[0].isPublished).toBe(true);
    expect(history[0].isLatest).toBe(true);
    expect(history[0].isDraft).toBe(false);
    expect(history.every((entry) => !entry.isDraft)).toBe(true);
    // The source of the restore is still its own row, not a duplicate.
    expect(history.filter((entry) => entry.id === first.id)).toHaveLength(1);
  });

  test("marks the newest unpublished revision as the draft", async () => {
    const first = await draft("First", editorId);
    await publishSlot({ slotId, revisionId: first.id });
    const second = await draft("Second", editorId);

    const slot = await getSlotById(slotId);
    if (!slot) throw new Error("slot missing");
    const { revisions: history } = await listSlotHistory(slot);

    expect(history[0].id).toBe(second.id);
    expect(history[0].isDraft).toBe(true);
    expect(history[1].isDraft).toBe(false);
    expect(history[1].isPublished).toBe(true);
  });

  // Slot history is paged: the newest 50, then a cursor to the next-oldest
  // revision via `?before=<id>`. Ordering is `(created_at, id)`, so the cursor
  // is that pair and equal timestamps don't skip or repeat a row.
  test("pages the newest 50 revisions, with a cursor for the older page", async () => {
    const total = HISTORY_PAGE_SIZE + 5;
    const ids: string[] = [];
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < total; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await db`
        INSERT INTO cms_revisions
          (id, target_type, target_id, content, created_by, created_at)
        VALUES (
          ${id},
          'slot',
          ${slotId},
          ${jsonbValue({ heading: `#${i}` })},
          ${editorId},
          ${new Date(base + i * 1000)}
        )
      `;
    }

    const slot = await getSlotById(slotId);
    if (!slot) throw new Error("slot missing");

    const first = await listSlotHistory(slot);
    expect(first.revisions).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.hasOlder).toBe(true);
    // Newest first, and only the top page marks the current draft.
    expect(first.revisions[0]?.id).toBe(ids[total - 1]);
    expect(first.revisions[0]?.isLatest).toBe(true);

    const cursor = first.revisions[first.revisions.length - 1]?.id as string;
    const second = await listSlotHistory(slot, { before: cursor });
    expect(second.revisions).toHaveLength(total - HISTORY_PAGE_SIZE);
    expect(second.hasOlder).toBe(false);
    expect(second.revisions.some((revision) => revision.isLatest)).toBe(false);

    // No revision appears on both pages, and together they are all of them.
    const paged = new Set(
      [...first.revisions, ...second.revisions].map((revision) => revision.id),
    );
    expect(paged.size).toBe(total);
    expect(paged).toEqual(new Set(ids));
  });

  // The other paging test seeds one distinct created_at per revision, so the id
  // half of the `(created_at, id)` cursor is never exercised. Here the boundary
  // falls inside a group saved in the same instant: only the id tie-break
  // separates the two pages, and a cursor on created_at alone would skip the
  // rest of the group or repeat the row it points at.
  test("pages across revisions saved in the same instant", async () => {
    const distinctCount = HISTORY_PAGE_SIZE - 6;
    const tiedCount = 11;
    const total = distinctCount + tiedCount;
    const distinctBase = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Older than every distinct revision, so the tied group sorts last and the
    // page boundary — the 50th row counted newest first — lands inside it.
    const tiedAt = new Date(Date.UTC(2025, 11, 31, 0, 0, 0));

    const insert = async (id: string, createdAt: Date): Promise<void> => {
      await db`
        INSERT INTO cms_revisions
          (id, target_type, target_id, content, created_by, created_at)
        VALUES (
          ${id},
          'slot',
          ${slotId},
          ${jsonbValue({ heading: "tie" })},
          ${editorId},
          ${createdAt}
        )
      `;
    };

    const ids: string[] = [];
    for (let i = 0; i < distinctCount; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await insert(id, new Date(distinctBase + i * 1000));
    }
    for (let i = 0; i < tiedCount; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await insert(id, tiedAt);
    }

    const slot = await getSlotById(slotId);
    if (!slot) throw new Error("slot missing");

    const first = await listSlotHistory(slot);
    expect(first.revisions).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.hasOlder).toBe(true);

    const cursor = first.revisions[first.revisions.length - 1]?.id as string;
    const second = await listSlotHistory(slot, { before: cursor });
    expect(second.hasOlder).toBe(false);

    // Both the last row of the first page and the first of the second share the
    // tied timestamp: the boundary really is inside the same-instant group.
    expect(first.revisions[HISTORY_PAGE_SIZE - 1]?.createdAt.getTime()).toBe(
      tiedAt.getTime(),
    );
    expect(second.revisions[0]?.createdAt.getTime()).toBe(tiedAt.getTime());

    const paged = [
      ...first.revisions.map((revision) => revision.id),
      ...second.revisions.map((revision) => revision.id),
    ];
    expect(paged).toHaveLength(total);
    expect(new Set(paged).size).toBe(total);
    expect(new Set(paged)).toEqual(new Set(ids));
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

    // History says where the copy came from; ordinary saves say nothing.
    const history = await listSlotHistory(slot as NonNullable<typeof slot>);
    const restored = history.revisions.find((r) => r.id === result.revision.id);
    expect(restored?.restoredFromAt).toEqual(first.createdAt);
    expect(
      history.revisions.filter((r) => r.restoredFromAt !== null),
    ).toHaveLength(1);
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
