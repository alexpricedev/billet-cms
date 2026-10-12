import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import {
  consumeUserToken,
  createMagicLink,
  createUserToken,
  findUserByEmail,
  findUserById,
  regenerateSession,
  verifyMagicLink,
} from "./auth";
import { db } from "./database";
import {
  createGuestSession,
  deleteSession,
  getSessionContextFromDB,
} from "./sessions";

/**
 * Seed the site identity, then mint its magic link.
 *
 * Sign-in is invite-only: `createMagicLink` returns null for an email
 * `cms_identities` does not expose, so every test that needs a live link seeds
 * the site user first.
 */
const magicLinkFor = async (email: string) => {
  await seedIdentity(db, email);
  const link = await createMagicLink(email);
  if (!link) throw new Error(`no identity for ${email}`);
  return link;
};

describe("Auth Service with PostgreSQL", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("cms_identities", () => {
    test("finds a site admin by email", async () => {
      const identity = await seedIdentity(db, "Admin@Example.com");

      const found = await findUserByEmail("admin@example.com");
      expect(found?.id).toBe(identity.id);
      expect(found?.email).toBe("admin@example.com");
      expect(found?.role).toBe("admin");
    });

    test("normalizes case and whitespace", async () => {
      const identity = await seedIdentity(db, "Findme@Example.com");

      const found = await findUserByEmail("  FINDME@example.COM  ");
      expect(found?.id).toBe(identity.id);
    });

    test("returns null for an email the view does not expose", async () => {
      // A site user who is not an admin: the default view filters them out.
      await seedIdentity(db, "member@example.com", "user");

      expect(await findUserByEmail("member@example.com")).toBeNull();
    });

    test("finds an identity by id, for a session re-read", async () => {
      const identity = await seedIdentity(db, "by-id@example.com");

      expect((await findUserById(identity.id))?.email).toBe(
        "by-id@example.com",
      );
      expect(
        await findUserById("00000000-0000-4000-8000-000000000000"),
      ).toBeNull();
    });
  });

  describe("createMagicLink", () => {
    test("creates a magic link for an existing identity", async () => {
      const user = await seedIdentity(db, "test@example.com");
      const link = await createMagicLink("test@example.com");

      expect(link).not.toBeNull();
      expect(link?.user.id).toBe(user.id);
      expect(link?.user.email).toBe(user.email);
      expect(typeof link?.rawToken).toBe("string");
      expect(link?.rawToken.length).toBeGreaterThan(20);
    });

    // Sign-in is invite-only and the CMS never writes the site's users. An
    // unknown address must not be provisioned, and neither a non-admin the
    // view keeps out nor a new address may create a `users` row.
    test("returns null for an unknown email, writing nothing", async () => {
      const before = await db`SELECT id FROM users`;

      expect(await createMagicLink("stranger@example.com")).toBeNull();

      expect(await db`SELECT id FROM users`).toHaveLength(before.length);
      expect(await db`SELECT id FROM cms_user_tokens`).toHaveLength(0);
    });

    test("returns null for a site user who is not an identity, writing nothing", async () => {
      await seedIdentity(db, "member@example.com", "user");
      const before = await db`SELECT id FROM users`;

      expect(await createMagicLink("member@example.com")).toBeNull();

      expect(await db`SELECT id FROM users`).toHaveLength(before.length);
      expect(await db`SELECT id FROM cms_user_tokens`).toHaveLength(0);
    });

    test("stores only the HMAC of the token", async () => {
      const { user, rawToken } = await magicLinkFor("hash@example.com");

      const tokens = await db`
        SELECT id, user_id, type, expires_at, used_at, token_hash
        FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      expect(tokens).toHaveLength(1);
      expect(tokens[0].user_id).toBe(user.id);
      expect(tokens[0].type).toBe("magic_link");
      expect(tokens[0].used_at).toBeNull();
      expect(tokens[0].token_hash).not.toBe(rawToken);

      // Expiry should be about 15 minutes from now
      const expiresAt = new Date(tokens[0].expires_at as string);
      const diffMinutes = (expiresAt.getTime() - Date.now()) / (1000 * 60);
      expect(diffMinutes).toBeGreaterThan(14);
      expect(diffMinutes).toBeLessThan(16);
    });
  });

  describe("verifyMagicLink", () => {
    test("successfully verifies valid unused token", async () => {
      const { user, rawToken } = await magicLinkFor("verify@example.com");

      const result = await verifyMagicLink(rawToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.user.id).toBe(user.id);
        expect(result.user.email).toBe(user.email);
        expect(result.sessionId).toBeDefined();
      }
    });

    test("marks token as used after verification", async () => {
      const { user, rawToken } = await magicLinkFor("used@example.com");

      await verifyMagicLink(rawToken);

      const tokens = await db`
        SELECT used_at FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      expect(tokens).toHaveLength(1);
      expect(tokens[0].used_at).not.toBeNull();
    });

    test("rejects already used token", async () => {
      const { rawToken } = await magicLinkFor("reuse@example.com");

      await verifyMagicLink(rawToken);
      const result = await verifyMagicLink(rawToken);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Invalid or expired token");
      }
    });

    test("prevents race condition with simultaneous verification attempts", async () => {
      const { rawToken } = await magicLinkFor("race@example.com");

      const [result1, result2] = await Promise.all([
        verifyMagicLink(rawToken),
        verifyMagicLink(rawToken),
      ]);

      const successes = [result1, result2].filter((r) => r.success);
      const failures = [result1, result2].filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
    });

    test("rejects invalid token", async () => {
      const result = await verifyMagicLink("invalid-token");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Invalid or expired token");
      }
    });

    test("rejects expired token", async () => {
      const { user, rawToken } = await magicLinkFor("expired@example.com");

      await db`
        UPDATE cms_user_tokens
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      const result = await verifyMagicLink(rawToken);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Invalid or expired token");
      }
    });

    test("refuses a token whose identity is no longer exposed", async () => {
      const { user, rawToken } = await magicLinkFor("gone@example.com");

      // The site removes the account between the email and the click.
      await db`DELETE FROM users WHERE id = ${user.id}`;

      const result = await verifyMagicLink(rawToken);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("User not found");
      }
    });
  });

  describe("integration scenarios", () => {
    test("complete magic link auth flow", async () => {
      const { user, rawToken } = await magicLinkFor("complete@example.com");
      expect(user.email).toBe("complete@example.com");

      const authResult = await verifyMagicLink(rawToken);
      expect(authResult.success).toBe(true);

      if (!authResult.success) return;

      const sessionData = await getSessionContextFromDB(authResult.sessionId);
      expect(sessionData?.user?.id).toBe(user.id);

      const loggedOut = await deleteSession(authResult.sessionId);
      expect(loggedOut).toBe(true);

      const noSession = await getSessionContextFromDB(authResult.sessionId);
      expect(noSession).toBeNull();
    });

    test("multiple users can have separate sessions", async () => {
      const { rawToken: token1 } = await magicLinkFor("user1@example.com");
      const { rawToken: token2 } = await magicLinkFor("user2@example.com");

      const auth1 = await verifyMagicLink(token1);
      const auth2 = await verifyMagicLink(token2);

      expect(auth1.success).toBe(true);
      expect(auth2.success).toBe(true);

      if (!auth1.success || !auth2.success) return;

      expect(auth1.sessionId).not.toBe(auth2.sessionId);
      expect(auth1.user.id).not.toBe(auth2.user.id);

      const session1 = await getSessionContextFromDB(auth1.sessionId);
      const session2 = await getSessionContextFromDB(auth2.sessionId);

      expect(session1?.user?.email).toBe("user1@example.com");
      expect(session2?.user?.email).toBe("user2@example.com");
    });
  });

  describe("createUserToken / consumeUserToken", () => {
    test("stores only the HMAC, never the raw token", async () => {
      const user = await seedIdentity(db, "tokens@example.com");
      const rawToken = await createUserToken(user.id, "magic_link");

      const rows = await db`
        SELECT token_hash, type FROM cms_user_tokens WHERE user_id = ${user.id}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("magic_link");
      expect(rows[0].token_hash).not.toBe(rawToken);
    });

    test("returns the owning identity id and marks the token used", async () => {
      const user = await seedIdentity(db, "consume@example.com");
      const rawToken = await createUserToken(user.id, "magic_link");

      expect(await consumeUserToken(rawToken, "magic_link")).toBe(user.id);

      const rows =
        await db`SELECT used_at FROM cms_user_tokens WHERE user_id = ${user.id}`;
      expect(rows[0].used_at).not.toBeNull();
    });

    test("is single-use", async () => {
      const user = await seedIdentity(db, "once@example.com");
      const rawToken = await createUserToken(user.id, "magic_link");

      expect(await consumeUserToken(rawToken, "magic_link")).toBe(user.id);
      expect(await consumeUserToken(rawToken, "magic_link")).toBeNull();
    });

    test("rejects an expired token", async () => {
      const user = await seedIdentity(db, "stale@example.com");
      const rawToken = await createUserToken(user.id, "magic_link");
      await db`UPDATE cms_user_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = ${user.id}`;

      expect(await consumeUserToken(rawToken, "magic_link")).toBeNull();
    });

    test("consumes concurrently without double-spending", async () => {
      const user = await seedIdentity(db, "tokenrace@example.com");
      const rawToken = await createUserToken(user.id, "magic_link");

      const results = await Promise.all([
        consumeUserToken(rawToken, "magic_link"),
        consumeUserToken(rawToken, "magic_link"),
      ]);

      expect(results.filter(Boolean)).toEqual([user.id]);
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

  describe("HMAC security", () => {
    test("database compromise cannot enable login", async () => {
      const { user, rawToken } = await magicLinkFor("security@example.com");

      const tokens = await db`
        SELECT token_hash FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      expect(tokens).toHaveLength(1);
      const storedHash = tokens[0].token_hash as string;

      const directHashResult = await verifyMagicLink(storedHash);
      expect(directHashResult.success).toBe(false);

      const validResult = await verifyMagicLink(rawToken);
      expect(validResult.success).toBe(true);
    });
  });

  describe("guest session upgrade", () => {
    test("deletes guest session and creates new session on login", async () => {
      const guestSessionId = await createGuestSession();

      const { user, rawToken } = await magicLinkFor("upgrade@example.com");

      const result = await verifyMagicLink(rawToken, guestSessionId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.sessionId).not.toBe(guestSessionId);
        expect(result.user.id).toBe(user.id);

        const oldSession = await getSessionContextFromDB(guestSessionId);
        expect(oldSession).toBeNull();

        const newSession = await getSessionContextFromDB(result.sessionId);
        expect(newSession?.isAuthenticated).toBe(true);
        expect(newSession?.user?.id).toBe(user.id);
      }
    });

    test("creates new session when no guestSessionId", async () => {
      const { user, rawToken } = await magicLinkFor("newuser@example.com");

      const result = await verifyMagicLink(rawToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.sessionId).toBeDefined();
        expect(result.user.id).toBe(user.id);

        const sessionContext = await getSessionContextFromDB(result.sessionId);
        expect(sessionContext?.isAuthenticated).toBe(true);
        expect(sessionContext?.user?.id).toBe(user.id);
      }
    });

    test("creates new session when guest upgrade fails", async () => {
      const { user, rawToken } = await magicLinkFor("fallback@example.com");

      const result = await verifyMagicLink(rawToken, "non-existent-session-id");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.sessionId).not.toBe("non-existent-session-id");
        expect(result.user.id).toBe(user.id);

        const sessionContext = await getSessionContextFromDB(result.sessionId);
        expect(sessionContext?.isAuthenticated).toBe(true);
        expect(sessionContext?.user?.id).toBe(user.id);
      }
    });
  });
});
