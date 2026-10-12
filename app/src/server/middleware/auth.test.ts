import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../services/database";
import {
  createAuthenticatedSession,
  createGuestSession,
} from "../services/sessions";
import { createBunRequest } from "../test-utils/bun-request";
import { getSessionContext, requireAuth } from "./auth";

describe("Auth Middleware", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("getSessionContext", () => {
    test("returns guest context with requiresSetCookie for request without cookie", async () => {
      const request = createBunRequest("http://localhost:3000/test");
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(false);
      expect(context.isGuest).toBe(true);
      expect(context.requiresSetCookie).toBe(true);
      expect(context.user).toBeNull();
      expect(context.sessionId).not.toBeNull();
      expect(context.sessionType).toBe("guest");
    });

    test("returns guest context with requiresSetCookie false for valid guest session", async () => {
      const sessionId = await createGuestSession();

      const request = createBunRequest("http://localhost:3000/test", {
        headers: { cookie: `cms_session=${sessionId}` },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(false);
      expect(context.isGuest).toBe(true);
      expect(context.requiresSetCookie).toBe(false);
      expect(context.user).toBeNull();
      expect(context.sessionId).toBe(sessionId);
      expect(context.sessionType).toBe("guest");
    });

    test("returns authenticated context with user data for valid authenticated session", async () => {
      const user = await seedIdentity(db, "valid@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const request = createBunRequest("http://localhost:3000/test", {
        headers: { cookie: `cms_session=${sessionId}` },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(true);
      expect(context.isGuest).toBe(false);
      expect(context.requiresSetCookie).toBe(false);
      expect(context.user).not.toBeNull();
      expect(context.user?.id).toBe(user.id);
      expect(context.user?.email).toBe(user.email);
      expect(context.sessionId).toBe(sessionId);
      expect(context.sessionType).toBe("authenticated");
    });

    test("returns guest context with requiresSetCookie for invalid session cookie", async () => {
      const request = createBunRequest("http://localhost:3000/test", {
        headers: { cookie: "cms_session=invalid-session-id" },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(false);
      expect(context.isGuest).toBe(true);
      expect(context.requiresSetCookie).toBe(true);
      expect(context.user).toBeNull();
    });

    test("returns guest context with requiresSetCookie for expired session", async () => {
      const user = await seedIdentity(db, "expired@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const { computeHMAC } = await import("../utils/crypto");
      const sessionIdHash = computeHMAC(sessionId);

      await db`
        UPDATE cms_sessions
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE id_hash = ${sessionIdHash}
      `;

      const request = createBunRequest("http://localhost:3000/test", {
        headers: { cookie: `cms_session=${sessionId}` },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(false);
      expect(context.isGuest).toBe(true);
      expect(context.requiresSetCookie).toBe(true);
      expect(context.user).toBeNull();
    });

    test("handles database errors gracefully", async () => {
      const request = createBunRequest("http://localhost:3000/test", {
        headers: { cookie: "cms_session=malformed-not-uuid" },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(false);
      expect(context.isGuest).toBe(true);
      expect(context.requiresSetCookie).toBe(true);
      expect(context.user).toBeNull();
    });

    test("handles multiple cookies correctly", async () => {
      const user = await seedIdentity(db, "cookies@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const request = createBunRequest("http://localhost:3000/test", {
        headers: {
          cookie: `other=value; cms_session=${sessionId}; another=value`,
        },
      });
      const context = await getSessionContext(request);

      expect(context.isAuthenticated).toBe(true);
      expect(context.user?.id).toBe(user.id);
    });
  });

  describe("requireAuth", () => {
    test("returns null for authenticated user", async () => {
      const user = await seedIdentity(db, "authed@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const request = createBunRequest("http://localhost:3000/protected", {
        headers: { cookie: `cms_session=${sessionId}` },
      });

      const result = await requireAuth(request);
      expect(result).toBeNull();
    });

    test("returns redirect response for unauthenticated user", async () => {
      const request = createBunRequest("http://localhost:3000/protected");

      const result = await requireAuth(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(303);
      expect(result?.headers.get("location")).toBe("/sign-in");
    });

    test("returns redirect for guest session", async () => {
      const sessionId = await createGuestSession();

      const request = createBunRequest("http://localhost:3000/protected", {
        headers: { cookie: `cms_session=${sessionId}` },
      });

      const result = await requireAuth(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(303);
      expect(result?.headers.get("location")).toBe("/sign-in");
    });

    test("returns redirect for expired session", async () => {
      const user = await seedIdentity(db, "expired2@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const { computeHMAC } = await import("../utils/crypto");
      const sessionIdHash = computeHMAC(sessionId);

      await db`
        UPDATE cms_sessions
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE id_hash = ${sessionIdHash}
      `;

      const request = createBunRequest("http://localhost:3000/protected", {
        headers: { cookie: `cms_session=${sessionId}` },
      });

      const result = await requireAuth(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(303);
      expect(result?.headers.get("location")).toBe("/sign-in");
    });
  });

  describe("integration scenarios", () => {
    test("complete auth flow with middleware", async () => {
      const email = "integration@example.com";

      let request = createBunRequest("http://localhost:3000/protected");
      let authResult = await requireAuth(request);
      expect(authResult?.status).toBe(303);
      expect(authResult?.headers.get("location")).toBe("/sign-in");

      const user = await seedIdentity(db, email);
      const sessionId = await createAuthenticatedSession(user.id);

      request = createBunRequest("http://localhost:3000/protected", {
        headers: { cookie: `cms_session=${sessionId}` },
      });
      authResult = await requireAuth(request);
      expect(authResult).toBeNull();

      const context = await getSessionContext(request);
      expect(context.isAuthenticated).toBe(true);
      expect(context.user?.email).toBe(email);
    });
  });
});
