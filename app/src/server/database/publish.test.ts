import { describe, expect, test } from "bun:test";
import {
  CmsNotSetUpError,
  ContractVersionMismatchError,
  publish,
  type SiteDefinitions,
} from "@alexpricedev/billet-cms/cli/publish";
import {
  block,
  image,
  link,
  pageType,
  slot,
  text,
} from "@alexpricedev/billet-cms/fields";
import type { SQL } from "bun";
import { createTempDatabase } from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";

/**
 * Publish against real tables.
 *
 * Every case gets a database of its own, the way the migration tests do: the
 * CMS shares its database with a site, and these tests write and mark removed
 * rows that a later case must not inherit.
 */
const withDatabase = async (
  suffix: string,
  body: (sql: SQL) => Promise<void>,
): Promise<void> => {
  const temp = await createTempDatabase(`publish-${suffix}`);

  try {
    const sql = temp.open();
    await runMigrations(sql);
    await body(sql);
  } finally {
    await temp.drop();
  }
};

const hero = block(
  "hero",
  {
    heading: text({ label: "Heading", max: 80 }),
    photo: image({ minWidth: 1600, aspect: "16:9" }),
  },
  () => null,
);
const cta = block("cta", { label: text(), target: link() }, () => null);
const landing = pageType("Landing", {
  allowedBlocks: [hero, cta],
  requiredBlocks: [hero],
  limits: { hero: { max: 1, position: "top" } },
});
// The same page type once `cta` is dropped, so a publish missing the block is
// still self-consistent (every allowed block must be declared).
const landingOnlyHero = pageType("Landing", {
  allowedBlocks: [hero],
  requiredBlocks: [hero],
  limits: { hero: { max: 1, position: "top" } },
});

const definitions: SiteDefinitions = {
  blocks: [hero, cta],
  pageTypes: [landing],
  slots: [slot("home.hero", hero), slot("home.cta", cta)],
};

interface BlockTypeRow {
  name: string;
  json_schema: Record<string, unknown>;
  fields: unknown[];
  schema_hash: string;
  removed_at: Date | null;
}

const readBlocks = async (sql: SQL): Promise<BlockTypeRow[]> =>
  (await sql`
    SELECT name, json_schema, fields, schema_hash, removed_at
    FROM cms_block_types ORDER BY name
  `) as BlockTypeRow[];

const snapshot = async (sql: SQL) => ({
  blocks: await sql`
    SELECT id, name, schema_hash, removed_at, updated_at
    FROM cms_block_types ORDER BY name
  `,
  pageTypes: await sql`
    SELECT id, name, schema_hash, removed_at, updated_at
    FROM cms_page_types ORDER BY name
  `,
  slots: await sql`
    SELECT id, name, block_name, page, removed_at, updated_at
    FROM cms_slots ORDER BY name
  `,
  meta: await sql`
    SELECT content_version, updated_at FROM cms_meta WHERE id = 1
  `,
});

describe("publish", () => {
  test("writes the site's declarations into the cms_ definition tables", async () => {
    await withDatabase("writes", async (sql) => {
      const summary = await publish(sql, definitions);

      expect(summary).toMatchObject({
        blocks: 2,
        pageTypes: 1,
        slots: 2,
        removedBlocks: 0,
        removedPageTypes: 0,
        removedSlots: 0,
        changed: true,
      });

      const blocks = await readBlocks(sql);
      expect(blocks.map((row) => row.name)).toEqual(["cta", "hero"]);

      const heroRow = blocks.find((row) => row.name === "hero");
      expect(heroRow?.removed_at).toBeNull();
      expect(heroRow?.schema_hash).toMatch(/^[0-9a-f]{64}$/);

      const properties = heroRow?.json_schema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties.heading).toMatchObject({
        type: "string",
        maxLength: 80,
      });
      // The metadata tree carries image guidance the CMS renders but the JSON
      // Schema cannot express.
      expect(heroRow?.fields).toContainEqual({
        name: "photo",
        kind: "image",
        required: true,
        image: { minWidth: 1600, aspect: "16:9" },
      });

      const slots = await sql`
        SELECT name, block_name, page FROM cms_slots ORDER BY name
      `;
      expect(slots).toEqual([
        { name: "home.cta", block_name: "cta", page: "home" },
        { name: "home.hero", block_name: "hero", page: "home" },
      ]);

      const pageTypes = await sql`
        SELECT name, allowed_blocks, required_blocks, block_limits
        FROM cms_page_types
      `;
      expect(pageTypes[0]).toMatchObject({
        name: "Landing",
        allowed_blocks: ["hero", "cta"],
        required_blocks: ["hero"],
        block_limits: { hero: { max: 1, position: "top" } },
      });
    });
  });

  test("re-publishing the same definitions changes nothing", async () => {
    await withDatabase("idempotent", async (sql) => {
      const first = await publish(sql, definitions);
      const before = await snapshot(sql);

      const second = await publish(sql, definitions);

      expect(second.changed).toBe(false);
      expect(second.contentVersion).toBe(first.contentVersion);
      expect(await snapshot(sql)).toEqual(before);
    });
  });

  test("a changed definition rewrites its row and bumps the content version", async () => {
    await withDatabase("changed", async (sql) => {
      const first = await publish(sql, definitions);
      const before = await readBlocks(sql);

      const resized = block(
        "hero",
        {
          heading: text({ label: "Heading", max: 40 }),
          photo: image({ minWidth: 1600, aspect: "16:9" }),
        },
        () => null,
      );
      const summary = await publish(sql, {
        ...definitions,
        blocks: [resized, cta],
      });

      expect(summary.changed).toBe(true);
      expect(summary.contentVersion).toBe(first.contentVersion + 1);

      const after = await readBlocks(sql);
      const beforeHero = before.find((row) => row.name === "hero");
      const afterHero = after.find((row) => row.name === "hero");
      expect(afterHero?.schema_hash).not.toBe(beforeHero?.schema_hash);
      expect(afterHero?.json_schema.properties).toMatchObject({
        heading: { maxLength: 40 },
      });
      // The unrelated block is left exactly as it was.
      expect(after.find((row) => row.name === "cta")?.schema_hash).toBe(
        before.find((row) => row.name === "cta")?.schema_hash,
      );
    });
  });

  test("a label-only page type change rewrites its row and bumps the content version", async () => {
    await withDatabase("page-type-label", async (sql) => {
      const first = await publish(sql, definitions);
      const [before] = (await sql`
        SELECT schema_hash, label, help FROM cms_page_types WHERE name = 'Landing'
      `) as {
        schema_hash: string;
        label: string | null;
        help: string | null;
      }[];

      const relabelled = pageType("Landing", {
        allowedBlocks: [hero, cta],
        requiredBlocks: [hero],
        limits: { hero: { max: 1, position: "top" } },
        label: "Landing page",
        help: "The home page",
      });
      const summary = await publish(sql, {
        ...definitions,
        pageTypes: [relabelled],
      });

      expect(summary.changed).toBe(true);
      expect(summary.contentVersion).toBe(first.contentVersion + 1);

      const [after] = (await sql`
        SELECT schema_hash, label, help FROM cms_page_types WHERE name = 'Landing'
      `) as {
        schema_hash: string;
        label: string | null;
        help: string | null;
      }[];
      expect(after?.schema_hash).not.toBe(before?.schema_hash);
      expect(after?.label).toBe("Landing page");
      expect(after?.help).toBe("The home page");
    });
  });

  test("a page type and a slot a deploy drops are marked removed; a re-add clears them and a change rewrites the slot", async () => {
    await withDatabase("removed-others", async (sql) => {
      await publish(sql, definitions);

      // Drop the page type but keep both slots.
      const noPageTypes: SiteDefinitions = {
        blocks: [hero, cta],
        pageTypes: [],
        slots: [slot("home.hero", hero), slot("home.cta", cta)],
      };
      const droppedPageType = await publish(sql, noPageTypes);
      expect(droppedPageType.removedPageTypes).toBe(1);
      expect(droppedPageType.removedSlots).toBe(0);
      const [landingRemoved] = await sql`
        SELECT removed_at FROM cms_page_types WHERE name = 'Landing'
      `;
      expect(landingRemoved?.removed_at).not.toBeNull();

      // Point home.cta at a different block and relabel it: its row is rewritten.
      const changedSlot = slot("home.cta", hero, { label: "Hero again" });
      const changed = await publish(sql, {
        blocks: [hero, cta],
        pageTypes: [],
        slots: [slot("home.hero", hero), changedSlot],
      });
      expect(changed.changed).toBe(true);
      const [ctaSlot] = await sql`
        SELECT block_name, label FROM cms_slots WHERE name = 'home.cta'
      `;
      expect(ctaSlot).toMatchObject({
        block_name: "hero",
        label: "Hero again",
      });

      // Re-add the page type and drop home.cta: one is cleared, the other removed.
      const readded = await publish(sql, {
        ...definitions,
        slots: [slot("home.hero", hero)],
      });
      expect(readded.changed).toBe(true);
      expect(readded.removedSlots).toBe(1);
      const [landingBack] = await sql`
        SELECT removed_at FROM cms_page_types WHERE name = 'Landing'
      `;
      expect(landingBack?.removed_at).toBeNull();
      const [ctaRemoved] = await sql`
        SELECT removed_at FROM cms_slots WHERE name = 'home.cta'
      `;
      expect(ctaRemoved?.removed_at).not.toBeNull();
    });
  });

  test("a definition a deploy drops is marked removed, never deleted, and re-adding clears it", async () => {
    await withDatabase("removed", async (sql) => {
      await publish(sql, definitions);

      const withoutCta: SiteDefinitions = {
        blocks: [hero],
        pageTypes: [landingOnlyHero],
        slots: [slot("home.hero", hero)],
      };
      const removed = await publish(sql, withoutCta);

      expect(removed.removedBlocks).toBe(1);
      expect(removed.removedSlots).toBe(1);
      expect(removed.changed).toBe(true);

      const [ctaRow] = await sql`
        SELECT removed_at FROM cms_block_types WHERE name = 'cta'
      `;
      expect(ctaRow?.removed_at).not.toBeNull();
      const firstRemovedAt = ctaRow?.removed_at;

      // A second deploy still without cta leaves the original timestamp alone.
      const removedAgain = await publish(sql, withoutCta);
      expect(removedAgain.changed).toBe(false);
      const [ctaAgain] = await sql`
        SELECT removed_at FROM cms_block_types WHERE name = 'cta'
      `;
      expect(ctaAgain?.removed_at).toEqual(firstRemovedAt);

      // Re-adding it clears removed_at.
      const readded = await publish(sql, definitions);
      expect(readded.changed).toBe(true);
      const [ctaReadded] = await sql`
        SELECT removed_at FROM cms_block_types WHERE name = 'cta'
      `;
      expect(ctaReadded?.removed_at).toBeNull();
    });
  });

  test("stops with a clear message when the CMS isn't set up", async () => {
    const temp = await createTempDatabase("publish-unset");

    try {
      const sql = temp.open();
      try {
        await publish(sql, definitions);
        throw new Error("expected publish to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CmsNotSetUpError);
        expect((error as Error).message).toMatch(/isn't set up/);
        expect((error as Error).message).toContain("cms_meta");
      }
    } finally {
      await temp.drop();
    }
  });

  test("stops with both versions named when the contract versions differ", async () => {
    await withDatabase("mismatch", async (sql) => {
      await sql`UPDATE cms_meta SET contract_version = '0.0.1' WHERE id = 1`;

      try {
        await publish(sql, definitions);
        throw new Error("expected publish to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ContractVersionMismatchError);
        expect((error as Error).message).toContain("0.0.1");
        expect((error as Error).message).toMatch(/mismatch/i);
      }
    });
  });
});
