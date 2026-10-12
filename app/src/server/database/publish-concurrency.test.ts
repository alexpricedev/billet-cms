import { describe, expect, test } from "bun:test";
import {
  publish,
  type SiteDefinitions,
} from "@alexpricedev/billet-cms/cli/publish";
import { block, pageType, slot, text } from "@alexpricedev/billet-cms/fields";
import type { SQL } from "bun";
import { createTempDatabase } from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";

const hero = block("hero", { heading: text() }, () => null);
const definitions: SiteDefinitions = {
  blocks: [hero],
  slots: [slot("home.hero", hero)],
  pageTypes: [pageType("landing", { allowedBlocks: [hero] })],
};

/**
 * Wait until `expected` sessions are queued on the blocker's row lock.
 *
 * A transaction blocked on `SELECT … FOR UPDATE` does not show a lock on the
 * table's relation: the first waiter takes a `tuple` lock and later ones wait
 * on the holder's transaction id. Both are matched here, scoped to the blocker
 * so `pg_locks` being cluster-wide can't inflate the count. Polling for the
 * real condition is what makes the race deterministic — the test releases the
 * lock only once both publishes are provably waiting.
 */
const waitForRowLockWaiters = async (
  sql: SQL,
  expected: number,
  blockerXid: number,
): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT count(*)::int AS waiters
      FROM pg_locks
      WHERE NOT granted
        AND (
          (locktype = 'tuple' AND relation = 'cms_meta'::regclass)
          OR (locktype = 'transactionid'
              AND transactionid::text = ${String(blockerXid)})
        )
    `;
    if ((rows[0] as { waiters: number }).waiters >= expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${expected} row-lock waiters`);
};

describe("concurrent publishes", () => {
  test("serialise on cms_meta, so one change is one content version bump", async () => {
    const temp = await createTempDatabase("publish-concurrent");

    try {
      const setup = temp.open();
      await runMigrations(setup);

      // Hold the meta row's lock so both publishes have to queue behind it.
      // Without the lock they would not queue at all, and the waiter poll
      // below would time out — which is the failure this test exists to catch.
      const blocker = temp.openOne();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired: () => void = () => {};
      const blockerAcquired = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      let blockerXid = 0;

      const holding = blocker.begin(async (tx) => {
        await tx`SELECT contract_version FROM cms_meta WHERE id = 1 FOR UPDATE`;
        const [row] = (await tx`
          SELECT pg_current_xact_id()::text AS xid
        `) as { xid: string }[];
        blockerXid = Number(row?.xid);
        acquired();
        await held;
      });
      await blockerAcquired;

      const a = temp.open();
      const b = temp.open();
      const watcher = temp.open();

      const first = publish(a, definitions);
      const second = publish(b, definitions);
      await waitForRowLockWaiters(watcher, 2, blockerXid);

      release();
      await holding;
      const [r1, r2] = await Promise.all([first, second]);

      // Exactly one publish did the work; the other found it already current.
      expect([r1.changed, r2.changed].filter(Boolean)).toHaveLength(1);
      expect(r1.contentVersion).toBe(2);
      expect(r2.contentVersion).toBe(2);

      const [meta] = (await setup`
        SELECT content_version FROM cms_meta WHERE id = 1
      `) as { content_version: string }[];
      expect(Number(meta?.content_version)).toBe(2);

      const [blocks] = (await setup`
        SELECT count(*)::int AS n FROM cms_block_types
      `) as { n: number }[];
      expect(blocks?.n).toBe(1);
    } finally {
      await temp.drop();
    }
  });
});
