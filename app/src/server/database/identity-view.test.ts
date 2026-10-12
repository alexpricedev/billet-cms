import { afterAll, describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
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

import { ensureIdentitiesView } from "./identity-view";
import { runMigrations } from "./migrate";

const viewDefinition = async (sql: SQL): Promise<string> => {
  const rows = await sql`
    SELECT pg_get_viewdef('cms_identities'::regclass, true) AS definition
  `;
  return (rows[0] as { definition: string }).definition;
};

describe("cms_identities view", () => {
  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("is created from the site's admins when it is missing", async () => {
    const temp = await createTempDatabase("identity-create");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).toContain("cms_identities");

      const definition = await viewDefinition(sql);
      expect(definition).toContain("users");
      expect(definition).toContain("admin");
    } finally {
      await temp.drop();
    }
  });

  // The rule the whole view exists for: the site owns its definition. A
  // CREATE OR REPLACE on every boot would quietly undo a site's editor roles.
  test("is left alone once a site has customised it", async () => {
    const temp = await createTempDatabase("identity-custom");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);
      await ensureIdentitiesView(sql);

      const defaultDefinition = await viewDefinition(sql);

      await sql`
        CREATE OR REPLACE VIEW cms_identities AS
        SELECT id, email, role FROM users
        WHERE role = ANY (ARRAY['admin', 'editor'])
      `;
      const customised = await viewDefinition(sql);
      expect(customised).not.toBe(defaultDefinition);

      await ensureIdentitiesView(sql);

      expect(await viewDefinition(sql)).toBe(customised);
    } finally {
      await temp.drop();
    }
  });

  test("is skipped while the site's users table does not exist", async () => {
    const temp = await createTempDatabase("identity-skip");

    try {
      const sql = temp.open();
      await runMigrations(sql);

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).not.toContain("cms_identities");
    } finally {
      await temp.drop();
    }
  });
});
