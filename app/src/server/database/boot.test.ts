import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import {
  createSiteTables,
  createTempDatabase,
  objectName,
  relationNames,
  schemaObjectNames,
} from "../test-utils/migration-helpers";
import { handleFallback } from "../utils/fallback";
import { ensureIdentitiesView } from "./identity-view";
import { runMigrations } from "./migrate";

const SITE_RELATIONS = ["migrations", "sessions", "user_tokens", "users"];

describe("a CMS boot against a site database", () => {
  test("creates only cms_ objects and writes the contract version", async () => {
    const temp = await createTempDatabase("boot");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      const before = new Set(await schemaObjectNames(sql));

      await runMigrations(sql);
      await ensureIdentitiesView(sql);

      // Every named object, not just tables and views: a CHECK constraint or an
      // index with a hand-picked name is exactly what a relation-only check
      // misses, and in a shared database it is what collides.
      const added = (await schemaObjectNames(sql)).filter(
        (object) => !before.has(object),
      );
      expect(added.length).toBeGreaterThan(0);
      // Prove the check sees more than tables: an index, a constraint and a
      // type must all be in the diff, or a narrowed query would pass silently.
      expect(
        added.some(
          (object) =>
            object.startsWith("relation:cms_") && object.endsWith("_idx"),
        ),
      ).toBe(true);
      expect(added.some((object) => object.startsWith("constraint:cms_"))).toBe(
        true,
      );
      expect(added.some((object) => object.startsWith("type:cms_"))).toBe(true);
      const unprefixed = added.filter(
        (object) => !objectName(object).startsWith("cms_"),
      );
      expect(unprefixed).toEqual([]);

      const relations = await relationNames(sql);
      const foreign = relations.filter(
        (name) => !name.startsWith("cms_") && !SITE_RELATIONS.includes(name),
      );
      expect(foreign).toEqual([]);
      expect(relations).toContain("cms_identities");

      const meta = await sql`
        SELECT contract_version, content_version FROM cms_meta WHERE id = 1
      `;
      const row = meta[0] as {
        contract_version: string;
        content_version: string;
      };
      expect(row.contract_version).toBe(CONTRACT_VERSION);
      // The site bumps this on publish; the CMS only seeds the row.
      expect(Number(row.content_version)).toBe(1);
    } finally {
      await temp.drop();
    }
  });
});

describe("/health", () => {
  test("answers 200 without touching the database", async () => {
    const response = await handleFallback(
      new Request("http://localhost/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
