import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

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

const insertHandoffToken = async (tokenHash: string, expiresAt: Date) => {
  await db`
    INSERT INTO cms_handoff_tokens (user_id, token_hash, expires_at)
    VALUES (
      ${"00000000-0000-4000-8000-000000000000"},
      ${tokenHash},
      ${expiresAt.toISOString()}
    )
  `;
};

const insertPreviewToken = async (tokenHash: string, expiresAt: Date) => {
  await db`
    INSERT INTO cms_preview_tokens
      (subject_type, subject_id, token_hash, expires_at)
    VALUES (
      ${"page"},
      ${"00000000-0000-4000-8000-000000000000"},
      ${tokenHash},
      ${expiresAt.toISOString()}
    )
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
      const user = await seedIdentity(db, "tokens@example.com");
      await insertToken(user.id, "expired-hash", new Date(Date.now() - HOUR));
      await insertToken(user.id, "live-hash", new Date(Date.now() + HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT token_hash FROM cms_user_tokens`;
      expect(rows.map((row: { token_hash: string }) => row.token_hash)).toEqual(
        ["live-hash"],
      );
    });

    test("deletes a spent token once it expires", async () => {
      const user = await seedIdentity(db, "spent@example.com");
      await insertToken(user.id, "spent-hash", new Date(Date.now() - HOUR));
      await db`UPDATE cms_user_tokens SET used_at = CURRENT_TIMESTAMP`;

      await runCleanupSweep();

      const rows = await db`SELECT id FROM cms_user_tokens`;
      expect(rows.length).toBe(0);
    });
  });

  describe("cms_handoff_tokens", () => {
    test("deletes expired handoff tokens and keeps live ones", async () => {
      await insertHandoffToken("expired-hash", new Date(Date.now() - HOUR));
      await insertHandoffToken("live-hash", new Date(Date.now() + HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT token_hash FROM cms_handoff_tokens`;
      expect(rows.map((row: { token_hash: string }) => row.token_hash)).toEqual(
        ["live-hash"],
      );
    });
  });

  describe("cms_preview_tokens", () => {
    test("deletes expired preview tokens and keeps live ones", async () => {
      await insertPreviewToken("expired-hash", new Date(Date.now() - HOUR));
      await insertPreviewToken("live-hash", new Date(Date.now() + HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT token_hash FROM cms_preview_tokens`;
      expect(rows.map((row: { token_hash: string }) => row.token_hash)).toEqual(
        ["live-hash"],
      );
    });
  });

  describe("cms_sessions", () => {
    test("deletes expired sessions and keeps live ones", async () => {
      const user = await seedIdentity(db, "sessions@example.com");
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
      const user = await seedIdentity(db, "keepme@example.com");
      await insertSession("expired-auth", user.id, new Date(Date.now() - HOUR));

      await runCleanupSweep();

      const rows = await db`SELECT id FROM users WHERE id = ${user.id}`;
      expect(rows.length).toBe(1);
    });
  });

  describe("startCleanupSweep", () => {
    test("sweeps once immediately and returns a stop handle", async () => {
      const user = await seedIdentity(db, "timer@example.com");
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
