import { afterAll, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import {
  createSiteTables,
  createTempDatabase,
  relationNames,
} from "../test-utils/migration-helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { runMigrations } from "./migrate";

// The site's own Billet tables, which must survive a CMS that shares its
// database. Named here so the assertions read as "and the site still works".
const SITE_RELATIONS = ["migrations", "sessions", "user_tokens", "users"];

describe("migrations against a database that already has a site's tables", () => {
  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("site tables first: the CMS adds only cms_ relations", async () => {
    const temp = await createTempDatabase("clash-site-first");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      const before = await relationNames(sql);

      await runMigrations(sql);

      const after = await relationNames(sql);
      const added = after.filter((name) => !before.includes(name));

      expect(added.length).toBeGreaterThan(0);
      // The whole point: nothing the CMS created can collide with the site.
      expect(added.every((name) => name.startsWith("cms_"))).toBe(true);
      expect(added).toContain("cms_users");
      expect(added).toContain("cms_sessions");
      expect(added).toContain("cms_user_tokens");
      expect(added).toContain("cms_meta");
      expect(added).toContain("cms_migrations");

      // And the site's tables are untouched.
      expect(after).toEqual(expect.arrayContaining(SITE_RELATIONS));
    } finally {
      await temp.drop();
    }
  });

  test("CMS first: the site's tables can be created afterwards", async () => {
    const temp = await createTempDatabase("clash-cms-first");

    try {
      const sql = temp.open();

      // The documented setup order: CMS first, then the site.
      await runMigrations(sql);

      const cmsOnly = await relationNames(sql);
      expect(cmsOnly.length).toBeGreaterThan(0);
      expect(cmsOnly.every((name) => name.startsWith("cms_"))).toBe(true);

      // The site's first deploy creates its own tables. No clash, either way.
      await createSiteTables(sql);

      const after = await relationNames(sql);
      expect(after).toEqual(expect.arrayContaining(SITE_RELATIONS));
      expect(after).toEqual(expect.arrayContaining(cmsOnly));
    } finally {
      await temp.drop();
    }
  });
});
