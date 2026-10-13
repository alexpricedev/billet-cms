import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import { block, image, richText, text } from "@alexpricedev/billet-cms/fields";
import {
  createContentReader,
  renderRichText,
} from "@alexpricedev/billet-cms/server";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

// The reader takes the site's own pool, so this file hands it the same test
// connection the CMS services use: one pool per file, whether the call goes
// through the mocked `db` module or straight to the helper.
import {
  createRevision,
  getLatestRevision,
  publishSlot,
  saveSlotDraft,
} from "./index";

const hero = block(
  "hero",
  {
    heading: text({ max: 80 }),
    body: richText(),
  },
  () => null,
);

const doc = (value: string): RichTextDocument => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
});

const content = (heading: string, body = doc("Hello")) => ({ heading, body });

/**
 * A stand-in for the part of a site's template that renders a slot: the reader
 * gives it validated content, and `renderRichText` turns the rich text into
 * markup. What this test proves is the whole read path a real page uses.
 */
const renderHero = (slot: Record<string, unknown> | null): string =>
  slot === null
    ? '<p class="empty">Hero coming soon</p>'
    : `<h1>${String(slot.heading)}</h1><div>${renderRichText(
        slot.body as RichTextDocument,
      )}</div>`;

describe("site content reader", () => {
  let slotId: string;
  let editorId: string;

  beforeEach(async () => {
    await cleanupTestData(connection);
    await seedBlockType(connection, hero);
    slotId = await seedSlot(connection, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });
    editorId = (await seedIdentity(connection, "editor@example.com")).id;
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const draft = async (value: string) => {
    const result = await saveSlotDraft({
      slotId,
      content: content(value),
      baseRevisionId: (await getLatestRevision("slot", slotId))?.id ?? null,
      actorId: editorId,
    });
    if (!result.ok) throw new Error("draft failed");
    return result.revision;
  };

  const reader = (onSkip?: (message: string) => void) =>
    createContentReader({
      sql: connection,
      ...(onSkip ? { onSkip } : { onSkip: () => {} }),
    });

  test("reads a published slot and renders it on the site", async () => {
    await draft("Live hero");
    await publishSlot({ slotId });

    const slot = await reader().getSlot("home.hero");
    expect(slot?.heading).toBe("Live hero");

    const html = renderHero(slot);
    expect(html).toContain("<h1>Live hero</h1>");
    expect(html).toContain("<p>Hello</p>");
  });

  test("returns nothing while a slot is only a draft", async () => {
    await draft("Not live yet");

    expect(await reader().getSlot("home.hero")).toBeNull();
    expect(renderHero(await reader().getSlot("home.hero"))).toContain(
      "Hero coming soon",
    );
  });

  // The stored schema is the published contract; the block's own Zod schema is
  // what the site's render function was written for. Passing `{ block }` checks
  // both, so a site whose code has moved past what was published skips the slot
  // instead of handing its renderer content it never expected.
  test("checks a published slot against the site's own block schema", async () => {
    await draft("Live hero");
    await publishSlot({ slotId });

    const matched = await reader().getSlot("home.hero", { block: hero });
    expect(matched?.heading).toBe("Live hero");
    expect(matched?.body).toEqual(doc("Hello"));

    // This definition expects an image where the stored revision holds text.
    const expectsImage = block("hero", { heading: image() }, () => null);
    const skipped: string[] = [];
    const stale = await reader((message) => skipped.push(message)).getSlot(
      "home.hero",
      { block: expectsImage },
    );

    expect(stale).toBeNull();
    expect(skipped.some((line) => line.includes("block's own schema"))).toBe(
      true,
    );
  });

  // Q3: the version is checked at most once a second, so a publish shows within
  // the interval without a webhook — and within the interval the cached value
  // is served without querying the version again.
  test("sees a publish after the version is re-checked", async () => {
    let now = 0;
    const cacheReader = createContentReader({
      sql: connection,
      now: () => now,
      onSkip: () => {},
    });

    await draft("First");
    await publishSlot({ slotId });
    expect((await cacheReader.getSlot("home.hero"))?.heading).toBe("First");

    await draft("Second");
    await publishSlot({ slotId });

    // Still inside the window: the cached revision is served.
    now = 500;
    expect((await cacheReader.getSlot("home.hero"))?.heading).toBe("First");

    // Past the window the version is re-read and the cache drops.
    now = 1000;
    expect((await cacheReader.getSlot("home.hero"))?.heading).toBe("Second");
  });

  test("skips published content that no longer validates, and logs it", async () => {
    // A revision written against an older schema, then pointed at directly as
    // if a deploy had changed the block under it.
    const invalid = await createRevision({
      targetType: "slot",
      targetId: slotId,
      content: { ...content("Bad"), heading: 42 },
      createdBy: editorId,
    });
    await connection`
      UPDATE cms_slots SET published_revision_id = ${invalid.id} WHERE id = ${slotId}
    `;

    const skipped: string[] = [];
    const slot = await reader((message) => skipped.push(message)).getSlot(
      "home.hero",
    );

    expect(slot).toBeNull();
    expect(skipped.some((line) => line.includes("no longer validates"))).toBe(
      true,
    );
    // The page around the bad slot still renders.
    expect(renderHero(slot)).toContain("Hero coming soon");
  });

  test("skips a slot whose block type a deploy removed", async () => {
    await draft("Live");
    await publishSlot({ slotId });
    await connection`
      UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'
    `;

    const skipped: string[] = [];
    const slot = await reader((message) => skipped.push(message)).getSlot(
      "home.hero",
    );

    expect(slot).toBeNull();
    expect(skipped.some((line) => line.includes("removed by a deploy"))).toBe(
      true,
    );
  });

  test("skips a slot that is no longer declared", async () => {
    await draft("Live");
    await publishSlot({ slotId });
    await connection`
      UPDATE cms_slots SET removed_at = NOW() WHERE id = ${slotId}
    `;

    const skipped: string[] = [];
    const slot = await reader((message) => skipped.push(message)).getSlot(
      "home.hero",
    );

    expect(slot).toBeNull();
    expect(skipped.some((line) => line.includes("no longer declared"))).toBe(
      true,
    );
  });

  test("returns nothing for a slot that was never declared", async () => {
    expect(await reader().getSlot("home.missing")).toBeNull();
  });
});
