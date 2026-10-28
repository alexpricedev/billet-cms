import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectQueryToReject } from "../test-utils/helpers";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/018_add_user_preferences";

/**
 * 018 adds `cms_user_preferences`, the table behind the account page's theme
 * choice: one row per identity, `system` until an editor saves something else.
 */
describe("018_add_user_preferences", () => {
  test("creates the table with a system default and a closed theme set", async () => {
    const temp = await createTempDatabase("migration-018");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const userId = randomUUID();
      const [saved] = (await sql`
        INSERT INTO cms_user_preferences (user_id)
        VALUES (${userId})
        RETURNING user_id, theme
      `) as { user_id: string; theme: string }[];
      expect(saved).toEqual({ user_id: userId, theme: "system" });

      for (const theme of ["light", "dark", "system"]) {
        await sql`
          UPDATE cms_user_preferences SET theme = ${theme}
          WHERE user_id = ${userId}
        `;
      }

      // Unknown values are refused by the database, not only by the service.
      await expectQueryToReject(
        () => sql`
          UPDATE cms_user_preferences SET theme = 'neon'
          WHERE user_id = ${userId}
        `,
        /cms_user_preferences_theme_check/,
      );
      const [unchanged] = (await sql`
        SELECT theme FROM cms_user_preferences WHERE user_id = ${userId}
      `) as { theme: string }[];
      expect(unchanged.theme).toBe("system");

      // Every relation and constraint the migration creates is cms_-prefixed.
      const relations = (await sql`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname LIKE 'cms\\_user\\_preferences%'
        ORDER BY c.relname
      `) as { relname: string }[];
      expect(relations.map((row) => row.relname)).toEqual([
        "cms_user_preferences",
        "cms_user_preferences_pkey",
      ]);

      const constraints = (await sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'cms_user_preferences'::regclass
        ORDER BY conname
      `) as { conname: string }[];
      expect(constraints.map((row) => row.conname)).toEqual([
        "cms_user_preferences_pkey",
        "cms_user_preferences_theme_check",
      ]);
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("down drops the table and up recreates it", async () => {
    const temp = await createTempDatabase("migration-018-down");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await down(sql);
      const gone =
        await sql`SELECT to_regclass('cms_user_preferences') AS relation`;
      expect(gone[0].relation).toBeNull();

      await up(sql);
      const back =
        await sql`SELECT to_regclass('cms_user_preferences') AS relation`;
      expect(back[0].relation).not.toBeNull();
    } finally {
      await temp.drop();
    }
  }, 60000);
});
