import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import {
  getPendingMigrations,
  rollbackLastMigration,
  runMigration,
  runMigrations,
} from "./migrate";

const unusedSql = (() => {
  throw new Error("the database must not be touched on this path");
}) as unknown as SQL;

describe("runMigration", () => {
  test("refuses a filename that is not a migration on disk", async () => {
    // `runRollback` builds the name from a `cms_migrations` row, so a path like
    // this must fail before the dynamic import can reach outside the directory.
    for (const filename of [
      "../../../../etc/passwd.ts",
      "015_not_a_real_file.ts",
      "001_initial_setup.js",
    ]) {
      await expect(runMigration(filename, unusedSql)).rejects.toThrow(
        /No such migration/,
      );
    }
  });
});

describe("rollbackLastMigration", () => {
  test("rolls the last migration back in one transaction and can re-apply it", async () => {
    const temp = await createTempDatabase("migrate-rollback");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const hasIndex = async (name: string): Promise<boolean> => {
        const rows = await sql`SELECT to_regclass(${name}) AS relation`;
        return (rows[0] as { relation: string | null }).relation !== null;
      };
      const appliedIds = async (): Promise<string[]> =>
        (
          (await sql`SELECT id FROM cms_migrations ORDER BY id`) as {
            id: string;
          }[]
        ).map((row) => row.id);

      const before = await appliedIds();
      const last = before[before.length - 1];
      expect(last).toBe("014_drop_handoff_user_index");
      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(false);

      await rollbackLastMigration(sql);

      const after = await appliedIds();
      expect(after).toEqual(before.slice(0, -1));
      // 014's down() recreates the index it dropped.
      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(true);

      // And the rollback is a normal pending migration again.
      expect(await getPendingMigrations(sql)).toEqual([
        "014_drop_handoff_user_index.ts",
      ]);

      await runMigrations(sql);
      expect(await appliedIds()).toEqual(before);
      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(false);
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("is a no-op on a database with nothing applied", async () => {
    const temp = await createTempDatabase("migrate-empty");

    try {
      const sql = temp.open();
      await rollbackLastMigration(sql);
      expect(
        (await sql`SELECT id FROM cms_migrations`) as { id: string }[],
      ).toEqual([]);
    } finally {
      await temp.drop();
    }
  }, 60000);
});
