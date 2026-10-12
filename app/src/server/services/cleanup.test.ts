import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { findOrCreateUser } from "./auth";
import { runCleanupSweep, startCleanupSweep } from "./cleanup";
import { db } from "./database";

const HOUR = 60 * 60 * 1000;

const insertSession = async (
  idHash: string,
  userId: string | null,
  expiresAt: Date,
) => {
  await db`
    INSERT INTO cms_sessions (id_hash, user_id, session_type, expires_at)
    VALUES (
      ${idHash},
      ${userId},
      ${userId ? "authenticated" : "guest"},
      ${expiresAt.toISOString()}
    )
  `;
};

const insertToken = async (
  userId: string,
  tokenHash: string,
  expiresAt: Date,
) => {
  await db`
    INSERT INTO cms_user_tokens (user_id, token_hash, type, expires_at)
    VALUES (${userId}, ${tokenHash}, ${"magic_link"}, ${expiresAt.toISOString()})
  `;
};

describe("Cleanup sweep", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("cms_user_tokens", () => {
    test("deletes expired tokens and keeps live ones", async () => {
      const user = await findOrCreateUser("tokens@example.com");
      await insertToken(user.id, "expired-hash", new Date(Date.now() - HOUR));
      await insertToken(user.id, "live-hash", new Date(Date.now() + HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT token_hash FROM cms_user_tokens`;
      expect(rows.map((row: { token_hash: string }) => row.token_hash)).toEqual(
        ["live-hash"],
      );
    });

    test("deletes a spent token once it expires", async () => {
      const user = await findOrCreateUser("spent@example.com");
      await insertToken(user.id, "spent-hash", new Date(Date.now() - HOUR));
      await db`UPDATE cms_user_tokens SET used_at = CURRENT_TIMESTAMP`;

      await runCleanupSweep();

      const rows = await db`SELECT id FROM cms_user_tokens`;
      expect(rows.length).toBe(0);
    });
  });

  describe("cms_sessions", () => {
    test("deletes expired sessions and keeps live ones", async () => {
      const user = await findOrCreateUser("sessions@example.com");
      await insertSession("expired-auth", user.id, new Date(Date.now() - HOUR));
      await insertSession("live-auth", user.id, new Date(Date.now() + HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT id_hash FROM cms_sessions`;
      expect(rows.map((row: { id_hash: string }) => row.id_hash)).toEqual([
        "live-auth",
      ]);
    });

    test("deletes expired guest sessions", async () => {
      await insertSession("expired-guest", null, new Date(Date.now() - HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT id_hash FROM cms_sessions`;
      expect(rows.length).toBe(0);
    });

    test("leaves the user the session belonged to alone", async () => {
      const user = await findOrCreateUser("keepme@example.com");
      await insertSession("expired-auth", user.id, new Date(Date.now() - HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT id FROM cms_users WHERE id = ${user.id}`;
      expect(rows.length).toBe(1);
    });
  });

  describe("startCleanupSweep", () => {
    test("sweeps once immediately and returns a stop handle", async () => {
      const user = await findOrCreateUser("timer@example.com");
      await insertToken(user.id, "expired-hash", new Date(Date.now() - HOUR));

      const stop = startCleanupSweep();
      try {
        // The first sweep is fired without being awaited, so give its promise a
        // turn of the loop before asserting.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const rows = await db`SELECT id FROM cms_user_tokens`;
        expect(rows.length).toBe(0);
      } finally {
        stop();
      }
    });

    test("is idempotent — a second sweep over swept tables is a no-op", async () => {
      await runCleanupSweep();
      await runCleanupSweep();

      const rows = await db`SELECT id_hash FROM cms_sessions`;
      expect(rows.length).toBe(0);
    });
  });
});
