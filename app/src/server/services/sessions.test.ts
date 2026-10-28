import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

const {
  createGuestSession,
  createAuthenticatedSession,
  getSessionContextFromDB,
  deleteSession,
  renewSession,
} = await import("./sessions");

const { computeHMAC } = await import("../utils/crypto");
const { setTheme } = await import("./preferences");
const { up: createPreferencesTable } = await import(
  "../database/migrations/018_add_user_preferences"
);

const db = connection;

afterAll(async () => {
  await connection.end();
  mock.restore();
});

beforeEach(async () => {
  await cleanupTestData(db);
});

describe("createGuestSession", () => {
  test("creates a session with type guest and null user_id", async () => {
    const rawId = await createGuestSession();
    expect(rawId).toBeTruthy();

    const hash = computeHMAC(rawId);
    const rows = await db`SELECT * FROM cms_sessions WHERE id_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_type).toBe("guest");
    expect(rows[0].user_id).toBeNull();
  });

  test("guest session expires in ~24 hours", async () => {
    const rawId = await createGuestSession();
    const hash = computeHMAC(rawId);
    const rows =
      await db`SELECT expires_at FROM cms_sessions WHERE id_hash = ${hash}`;
    const expiresAt = new Date(rows[0].expires_at);
    const diff = expiresAt.getTime() - Date.now();
    const hours = diff / (1000 * 60 * 60);
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });
});

describe("createAuthenticatedSession", () => {
  test("creates a session with type authenticated and user_id", async () => {
    const user = await seedIdentity(db, "test@example.com");
    const rawId = await createAuthenticatedSession(user.id);

    const hash = computeHMAC(rawId);
    const rows = await db`SELECT * FROM cms_sessions WHERE id_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_type).toBe("authenticated");
    expect(rows[0].user_id).toBe(user.id);
  });

  test("authenticated session expires in ~30 days", async () => {
    const user = await seedIdentity(db, "test@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    const hash = computeHMAC(rawId);
    const rows =
      await db`SELECT expires_at FROM cms_sessions WHERE id_hash = ${hash}`;
    const expiresAt = new Date(rows[0].expires_at);
    const diff = expiresAt.getTime() - Date.now();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });
});

describe("getSessionContextFromDB", () => {
  test("returns null for non-existent session", async () => {
    const result = await getSessionContextFromDB("non-existent-id");
    expect(result).toBeNull();
  });

  test("returns guest context for guest session", async () => {
    const rawId = await createGuestSession();
    const ctx = await getSessionContextFromDB(rawId);

    expect(ctx).not.toBeNull();
    expect(ctx?.sessionType).toBe("guest");
    expect(ctx?.isGuest).toBe(true);
    expect(ctx?.isAuthenticated).toBe(false);
    expect(ctx?.user).toBeNull();
    expect(ctx?.sessionId).toBe(rawId);
    expect(ctx?.sessionHash).toBeTruthy();
  });

  test("returns authenticated context with user for authenticated session", async () => {
    const user = await seedIdentity(db, "auth@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    const ctx = await getSessionContextFromDB(rawId);

    expect(ctx).not.toBeNull();
    expect(ctx?.sessionType).toBe("authenticated");
    expect(ctx?.isGuest).toBe(false);
    expect(ctx?.isAuthenticated).toBe(true);
    expect(ctx?.user).not.toBeNull();
    expect(ctx?.user?.email).toBe("auth@example.com");
  });

  test("carries the editor's saved theme on the user", async () => {
    const user = await seedIdentity(db, "dark@example.com");
    await setTheme(user.id, "dark");
    const rawId = await createAuthenticatedSession(user.id);

    const ctx = await getSessionContextFromDB(rawId);
    expect(ctx?.user?.theme).toBe("dark");
  });

  test("reads system when the editor has no preferences row", async () => {
    const user = await seedIdentity(db, "default@example.com");
    const rawId = await createAuthenticatedSession(user.id);

    const ctx = await getSessionContextFromDB(rawId);
    expect(ctx?.user?.theme).toBe("system");
  });

  test("returns null for expired session", async () => {
    const rawId = await createGuestSession();
    const hash = computeHMAC(rawId);
    await db`UPDATE cms_sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id_hash = ${hash}`;

    const ctx = await getSessionContextFromDB(rawId);
    expect(ctx).toBeNull();
  });
});

describe("deleteSession", () => {
  test("deletes an existing session", async () => {
    const rawId = await createGuestSession();
    const result = await deleteSession(rawId);
    expect(result).toBe(true);

    const hash = computeHMAC(rawId);
    const rows = await db`SELECT * FROM cms_sessions WHERE id_hash = ${hash}`;
    expect(rows).toHaveLength(0);
  });

  test("returns false for non-existent session", async () => {
    const result = await deleteSession("non-existent");
    expect(result).toBe(false);
  });
});

describe("a missing cms_identities view", () => {
  // The view is a site-owned definition the CMS creates only when missing, so
  // it can be absent for a while. A session must still be readable.
  const recreateView = async () => {
    const rows = (await db`
      SELECT to_regclass('cms_identities') AS relation
    `) as { relation: string | null }[];
    if (!rows[0]?.relation) {
      await db`
        CREATE VIEW cms_identities AS
        SELECT id, email, role FROM users WHERE role = 'admin'
      `;
    }
  };

  test("does not discard a guest session", async () => {
    const rawId = await createGuestSession();
    await db`DROP VIEW cms_identities`;

    try {
      const ctx = await getSessionContextFromDB(rawId);
      expect(ctx).not.toBeNull();
      expect(ctx?.isGuest).toBe(true);
      expect(ctx?.sessionId).toBe(rawId);
    } finally {
      await recreateView();
    }
  });

  test("returns the session but no user, rather than nothing", async () => {
    const user = await seedIdentity(db, "view-missing@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    await db`DROP VIEW cms_identities`;

    try {
      const ctx = await getSessionContextFromDB(rawId);
      expect(ctx).not.toBeNull();
      expect(ctx?.isAuthenticated).toBe(false);
      expect(ctx?.user).toBeNull();
    } finally {
      await recreateView();
    }
  });
});

describe("a missing cms_user_preferences table", () => {
  // Preferences are an enhancement on the session, not a condition of it: a
  // database where the table is absent or mid-migration must still sign the
  // editor in, on the default theme.
  test("returns the session and its user, on system", async () => {
    const user = await seedIdentity(db, "no-preferences@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    await db`DROP TABLE cms_user_preferences`;

    try {
      const ctx = await getSessionContextFromDB(rawId);
      expect(ctx).not.toBeNull();
      expect(ctx?.isAuthenticated).toBe(true);
      expect(ctx?.user?.id).toBe(user.id);
      expect(ctx?.user?.theme).toBe("system");
    } finally {
      await createPreferencesTable(db);
    }
  });
});

describe("identity removal", () => {
  // The view is re-read on every request, so a site that removes or demotes an
  // account ends the session at the next request rather than the cookie expiry.
  test("ends the session when the account is deleted", async () => {
    const user = await seedIdentity(db, "gone@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    expect((await getSessionContextFromDB(rawId))?.isAuthenticated).toBe(true);

    await db`DELETE FROM users WHERE id = ${user.id}`;

    const ctx = await getSessionContextFromDB(rawId);
    expect(ctx).not.toBeNull();
    expect(ctx?.isAuthenticated).toBe(false);
    expect(ctx?.user).toBeNull();
  });

  test("ends the session when the account is demoted out of the view", async () => {
    const user = await seedIdentity(db, "demoted@example.com");
    const rawId = await createAuthenticatedSession(user.id);

    await db`UPDATE users SET role = 'user' WHERE id = ${user.id}`;

    expect((await getSessionContextFromDB(rawId))?.isAuthenticated).toBe(false);
  });
});

describe("renewSession", () => {
  test("updates last_activity_at", async () => {
    const user = await seedIdentity(db, "renew@example.com");
    const rawId = await createAuthenticatedSession(user.id);
    const hash = computeHMAC(rawId);

    const before =
      await db`SELECT last_activity_at FROM cms_sessions WHERE id_hash = ${hash}`;
    await new Promise((r) => setTimeout(r, 50));
    await renewSession(rawId);
    const after =
      await db`SELECT last_activity_at FROM cms_sessions WHERE id_hash = ${hash}`;

    expect(new Date(after[0].last_activity_at).getTime()).toBeGreaterThan(
      new Date(before[0].last_activity_at).getTime(),
    );
  });
});
