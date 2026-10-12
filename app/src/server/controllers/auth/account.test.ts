import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createBunRequest } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, withIndexingAllowed } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { findOrCreateUser } from "../../services/auth";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { account } from "./account";

const ORIGIN = process.env.APP_URL as string;

const getAccount = (sessionId?: string) =>
  createBunRequest(`${ORIGIN}/account`, {
    method: "GET",
    ...(sessionId ? { headers: { cookie: `session_id=${sessionId}` } } : {}),
  });

describe("Account Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("GET /account", () => {
    test("redirects an anonymous visitor to sign in", async () => {
      const response = await account.index(getAccount());

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    });

    test("shows the email and the sign-in method", async () => {
      const user = await findOrCreateUser("me@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toContain("me@example.com");
      expect(html).toContain("Magic link");
      expect(html).toContain('action="/auth/logout"');
    });

    test("mints a CSRF token for the sign-out form", async () => {
      const user = await findOrCreateUser("tokens@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toMatch(/name="_csrf" value="[^"]+"/);
    });

    test("is noindex", async () => {
      const user = await findOrCreateUser("hidden@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      // Indexing opened so the noindex asserted below is the page's own.
      const html = await withIndexingAllowed(async () =>
        (await account.index(getAccount(sessionId))).text(),
      );

      expect(html).toContain('name="robots" content="noindex, nofollow"');
    });
  });
});
