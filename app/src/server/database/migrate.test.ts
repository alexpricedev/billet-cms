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

describe("migrate status", () => {
  // A status command must not write. It used to call `ensureMigrationsTable`
  // and create `cms_migrations` on a database that had never been migrated.
  test("lists pending migrations without creating the tracking table", async () => {
    const temp = await createTempDatabase("migrate-status");

    try {
      const sql = temp.open();
      await createSiteTables(sql);

      const pending = await getPendingMigrations(sql);
      expect(pending.length).toBeGreaterThan(0);

      const rows = (await sql`
        SELECT to_regclass('cms_migrations') AS relation
      `) as { relation: string | null }[];
      expect(rows[0].relation).toBeNull();
    } finally {
      await temp.drop();
    }
  }, 60000);
});

describe("rollbackLastMigration", () => {
  // Asserted against whatever migration file is last on disk, not a hardcoded
  // id: adding the next migration must not break this test. What a specific
  // migration's `down()` restores (014's index, say) belongs in that
  // migration's own test — migration-014-handoff-index.test.ts.
  test("rolls the last migration back in one transaction and can re-apply it", async () => {
    const temp = await createTempDatabase("migrate-rollback");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const appliedIds = async (): Promise<string[]> =>
        (
          (await sql`SELECT id FROM cms_migrations ORDER BY id`) as {
            id: string;
          }[]
        ).map((row) => row.id);

      const before = await appliedIds();
      const last = before[before.length - 1];
      expect(last).toBeDefined();

      await rollbackLastMigration(sql);

      const after = await appliedIds();
      expect(after).toEqual(before.slice(0, -1));

      // And the rolled-back migration is a normal pending one again.
      expect(await getPendingMigrations(sql)).toEqual([`${last}.ts`]);

      await runMigrations(sql);
      expect(await appliedIds()).toEqual(before);
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
