import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEditContentLink } from "@alexpricedev/billet-cms/handoff";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "./database";
import { consumeHandoffToken, redeemHandoffToken } from "./handoff";
import { getSessionContextFromDB } from "./sessions";

const CMS_URL = "https://cms.example.com";

const tokenFrom = (link: string): string => {
  const token = new URL(link).searchParams.get("token");
  if (!token) throw new Error(`no token in ${link}`);
  return token;
};

const mintLink = async (userId: string): Promise<string | null> =>
  createEditContentLink(db, { userId, cmsUrl: CMS_URL });

describe("Edit content handoff", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("createEditContentLink (the site's half)", () => {
    test("mints a single-use, 60-second token the CMS can spend", async () => {
      const identity = await seedIdentity(db, "admin@example.com");

      const link = await mintLink(identity.id);

      expect(link).toStartWith(`${CMS_URL}/handoff?token=`);
      const token = tokenFrom(link as string);

      const rows = await db`
        SELECT user_id, token_hash, expires_at, used_at
        FROM cms_handoff_tokens
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(identity.id);
      expect(rows[0].used_at).toBeNull();
      // Only the hash is stored, never the raw token.
      expect(rows[0].token_hash).not.toBe(token);

      const expiresAt = new Date(rows[0].expires_at as string);
      const seconds = (expiresAt.getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(55);
      expect(seconds).toBeLessThan(65);
    });

    test("hides the link for a user who is not an identity", async () => {
      const member = await seedIdentity(db, "member@example.com", "user");

      expect(await mintLink(member.id)).toBeNull();
      expect(await db`SELECT id FROM cms_handoff_tokens`).toHaveLength(0);
    });

    test("hides the link when the site has no CMS URL (Q8)", async () => {
      const identity = await seedIdentity(db, "admin@example.com");

      expect(
        await createEditContentLink(db, { userId: identity.id, cmsUrl: "" }),
      ).toBeNull();
    });
  });

  describe("redeemHandoffToken (the CMS's half)", () => {
    test("spends the token and starts the session", async () => {
      const identity = await seedIdentity(db, "admin@example.com");
      const token = tokenFrom((await mintLink(identity.id)) as string);

      const result = await redeemHandoffToken(token);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.user.id).toBe(identity.id);
      expect(result.user.email).toBe("admin@example.com");

      const ctx = await getSessionContextFromDB(result.sessionId);
      expect(ctx?.isAuthenticated).toBe(true);
      expect(ctx?.user?.id).toBe(identity.id);

      // The row is marked spent.
      const rows = await consumeHandoffToken(token);
      expect(rows).toBeNull();
    });

    test("is single use — a second click signs nobody in", async () => {
      const identity = await seedIdentity(db, "admin@example.com");
      const token = tokenFrom((await mintLink(identity.id)) as string);

      expect((await redeemHandoffToken(token)).success).toBe(true);

      const second = await redeemHandoffToken(token);
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error).toBe("Invalid or expired link");
      }
    });

    test("refuses an expired token", async () => {
      const identity = await seedIdentity(db, "admin@example.com");
      const token = tokenFrom((await mintLink(identity.id)) as string);

      await db`
        UPDATE cms_handoff_tokens
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
      `;

      expect((await redeemHandoffToken(token)).success).toBe(false);
    });

    test("refuses a token whose identity is no longer exposed", async () => {
      const identity = await seedIdentity(db, "admin@example.com");
      const token = tokenFrom((await mintLink(identity.id)) as string);

      await db`DELETE FROM users WHERE id = ${identity.id}`;

      const result = await redeemHandoffToken(token);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("This account can no longer sign in");
      }
    });
  });
});
