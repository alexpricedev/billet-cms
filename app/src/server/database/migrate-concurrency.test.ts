import { afterAll, describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { testDatabase } from "../test-utils/database";
import { createTempDatabase } from "../test-utils/migration-helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import { runMigrations } from "./migrate";

const migrationIds = (): string[] =>
  readdirSync(join(process.cwd(), "src/server/database/migrations"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(".ts", ""))
    .sort();

describe("concurrent boots", () => {
  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("apply each migration exactly once", async () => {
    // Two connections in one transaction can't race on a session-scoped lock,
    // so this needs a database of its own and a client per boot.
    const temp = await createTempDatabase("concurrent");

    try {
      const bootA = temp.open();
      const bootB = temp.open();

      await Promise.all([runMigrations(bootA), runMigrations(bootB)]);

      const rows = await bootA`SELECT id FROM cms_migrations ORDER BY id`;
      const recorded = (rows as { id: string }[]).map((row) => row.id);

      // Every migration on disk, once — no duplicates, none skipped.
      expect(recorded).toEqual(migrationIds());
      expect(new Set(recorded).size).toBe(recorded.length);

      const meta =
        await bootA`SELECT contract_version FROM cms_meta WHERE id = 1`;
      expect((meta[0] as { contract_version: string }).contract_version).toBe(
        CONTRACT_VERSION,
      );
    } finally {
      await temp.drop();
    }
  });
});
