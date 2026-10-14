import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { createTempDatabase } from "../test-utils/migration-helpers";
import {
  IDENTITY_VIEW_LOCK_SUBKEY,
  LOCK_NAMESPACE,
  MIGRATION_LOCK_SUBKEY,
} from "./advisory-locks";
import { ensureIdentitiesView } from "./identity-view";
import { runMigrations } from "./migrate";

const migrationIds = (): string[] =>
  readdirSync(join(process.cwd(), "src/server/database/migrations"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(".ts", ""))
    .sort();

/**
 * Wait until `expected` sessions are queued on an advisory lock.
 *
 * Polling for the real condition is what makes the race deterministic: the test
 * releases the lock only once both boots are provably inside their transaction
 * and blocked, rather than hoping the two `runMigrations` calls overlap.
 */
const waitForLockWaiters = async (
  sql: SQL,
  expected: number,
): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // Scoped to this database: `pg_locks` is cluster-wide, and other workers
    // running migration tests concurrently would otherwise inflate the count
    // and release the lock before both boots have queued.
    const rows = await sql`
      SELECT count(*)::int AS waiters
      FROM pg_locks l
      JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory'
        AND NOT l.granted
        AND d.datname = current_database()
    `;
    if ((rows[0] as { waiters: number }).waiters >= expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${expected} advisory-lock waiters`);
};

describe("concurrent boots", () => {
  test("apply each migration exactly once", async () => {
    // The migration lock is transaction-scoped, so two boots have to run on two
    // connections: this needs a database of its own and a client per boot.
    const temp = await createTempDatabase("concurrent");

    try {
      // Hold the migration lock so both boots have to queue behind it. Without
      // this they might run end to end with no overlap at all, and the test
      // would pass whether or not the lock exists.
      const blocker = temp.open();
      await blocker`SELECT pg_advisory_lock(hashtext(${LOCK_NAMESPACE}), ${MIGRATION_LOCK_SUBKEY})`;

      const bootA = temp.open();
      const bootB = temp.open();
      const watcher = temp.open();

      const migrations = Promise.all([
        runMigrations(bootA),
        runMigrations(bootB),
      ]);
      await waitForLockWaiters(watcher, 2);

      await blocker`SELECT pg_advisory_unlock(hashtext(${LOCK_NAMESPACE}), ${MIGRATION_LOCK_SUBKEY})`;
      await migrations;

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

  // The identity-view check takes the shared namespace's subkey 2, not a
  // hand-picked integer in a different lock space (review round 2). Holding that
  // exact key must make `ensureIdentitiesView` queue; if it took any other key,
  // it would run straight through and the wait below would time out.
  test("the identity-view check queues on the namespace's subkey 2", async () => {
    const temp = await createTempDatabase("identity-lock");

    try {
      const blocker = temp.open();
      await blocker`SELECT pg_advisory_lock(hashtext(${LOCK_NAMESPACE}), ${IDENTITY_VIEW_LOCK_SUBKEY})`;

      const sql = temp.open();
      const watcher = temp.open();

      const view = ensureIdentitiesView(sql);
      await waitForLockWaiters(watcher, 1);

      await blocker`SELECT pg_advisory_unlock(hashtext(${LOCK_NAMESPACE}), ${IDENTITY_VIEW_LOCK_SUBKEY})`;
      await view;
    } finally {
      await temp.drop();
    }
  });
});
