import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { findUserById, regenerateSession } from "./auth";
import { db } from "./database";
import { createGuestSession, getSessionContextFromDB } from "./sessions";

describe("Auth Service with PostgreSQL", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("cms_identities", () => {
    test("finds an identity by id, for a session re-read", async () => {
      const identity = await seedIdentity(db, "by-id@example.com");

      expect((await findUserById(identity.id))?.email).toBe(
        "by-id@example.com",
      );
      expect(
        await findUserById("00000000-0000-4000-8000-000000000000"),
      ).toBeNull();
    });

    test("does not expose a site user who is not an admin under the default view", async () => {
      const member = await seedIdentity(db, "member@example.com", "user");

      expect(await findUserById(member.id)).toBeNull();
    });
  });

  describe("regenerateSession", () => {
    test("drops the guest session and issues a different one", async () => {
      const user = await seedIdentity(db, "regen@example.com");
      const guestSessionId = await createGuestSession();

      const sessionId = await regenerateSession(user.id, guestSessionId);

      expect(sessionId).not.toBe(guestSessionId);
      expect(await getSessionContextFromDB(guestSessionId)).toBeNull();

      const ctx = await getSessionContextFromDB(sessionId);
      expect(ctx?.isAuthenticated).toBe(true);
      expect(ctx?.user?.id).toBe(user.id);
    });

    test("works with no guest session to discard", async () => {
      const user = await seedIdentity(db, "regen-noguest@example.com");

      const ctx = await getSessionContextFromDB(
        await regenerateSession(user.id),
      );
      expect(ctx?.isAuthenticated).toBe(true);
    });
  });
});
