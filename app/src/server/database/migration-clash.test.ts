import { describe, expect, test } from "bun:test";
import {
  createSiteTables,
  createTempDatabase,
  objectName,
  schemaObjectNames,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";

// The site's own Billet tables, which must survive a CMS that shares its
// database. Named here so the assertions read as "and the site still works".
const SITE_RELATIONS = ["migrations", "sessions", "user_tokens", "users"];

// Billet v5.1.0's own indexes, under the names it ships them with. The CMS
// renamed its copies, so none of these may be touched or reused.
const SITE_INDEXES = [
  "idx_sessions_user_id",
  "idx_sessions_expires_at",
  "idx_sessions_last_activity",
  "idx_sessions_csrf_secret",
  "idx_sessions_session_type",
  "idx_user_tokens_user_id",
  "idx_user_tokens_type",
  "idx_user_tokens_expires_at",
];

// The constraints the site's schema carries, inline and unnamed in the DDL, so
// Postgres generated these names. A `cms_` rename that caught the columns but
// not a constraint would show up here.
const SITE_CONSTRAINTS = [
  "users_email_key",
  "users_role_check",
  "sessions_user_id_fkey",
  "user_tokens_token_hash_key",
  "user_tokens_user_id_fkey",
];

/** Every object name — relation, index, constraint, type — not already present. */
const addedObjects = (before: string[], after: string[]): string[] => {
  const seen = new Set(before);
  return after.filter((object) => !seen.has(object));
};

const expectNothingUnprefixed = (objects: string[]): void => {
  expect(objects.filter((o) => !objectName(o).startsWith("cms_"))).toEqual([]);
};

const expectSiteObjectsIntact = (objects: string[]): void => {
  const names = new Set(objects.map(objectName));
  for (const name of [
    ...SITE_RELATIONS,
    ...SITE_INDEXES,
    ...SITE_CONSTRAINTS,
  ]) {
    expect(names).toContain(name);
  }
};

describe("migrations against a database that already has a site's tables", () => {
  test("site tables first: the CMS adds only cms_ objects", async () => {
    const temp = await createTempDatabase("clash-site-first");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      const before = await schemaObjectNames(sql);

      await runMigrations(sql);

      const after = await schemaObjectNames(sql);
      const added = addedObjects(before, after);

      expect(added.length).toBeGreaterThan(0);
      // The check is only as strong as what it sees: assert the diff really
      // carries indexes, constraints and types, not just tables. Without this a
      // narrowing of the query would leave the test passing and weaker.
      expect(
        added.some((o) => o.startsWith("relation:cms_") && o.endsWith("_idx")),
      ).toBe(true);
      expect(added.some((o) => o.startsWith("constraint:cms_"))).toBe(true);
      expect(added.some((o) => o.startsWith("type:cms_"))).toBe(true);
      // The whole point: nothing the CMS created can collide with the site —
      // not an index, not a CHECK constraint, not a generated type.
      expectNothingUnprefixed(added);
      expect(added).toContain("relation:cms_sessions");
      expect(added).toContain("relation:cms_user_tokens");
      expect(added).toContain("relation:cms_meta");
      expect(added).toContain("relation:cms_migrations");
      expect(added).toContain("relation:cms_revisions");
      expect(added).toContain("relation:cms_handoff_tokens");
      expect(added).toContain("relation:cms_preview_tokens");
      expect(added).toContain("relation:cms_pages");
      expect(added).toContain("relation:cms_redirects");
      expect(added).not.toContain("relation:cms_users");

      // And the site's tables, indexes and constraints are untouched.
      expectSiteObjectsIntact(after);
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

      const cmsOnly = await schemaObjectNames(sql);
      expect(cmsOnly.length).toBeGreaterThan(0);
      expectNothingUnprefixed(cmsOnly);

      // The site's first deploy creates its own tables, indexes and
      // constraints. No clash, either way.
      await createSiteTables(sql);

      const after = await schemaObjectNames(sql);
      expectSiteObjectsIntact(after);
      expect(after).toEqual(expect.arrayContaining(cmsOnly));
    } finally {
      await temp.drop();
    }
  });
});
