import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { createBunRequest } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import {
  cleanupTestData,
  seedIdentity,
  withIndexingAllowed,
} from "../../test-utils/helpers";

const connection = testDatabase();

// Count the session-context read, so a double load shows up. The account page
// used to call `requireAuth` (which loads and renews the context) and then load
// the same session again itself. The CSRF secret lookup reads the same table, so
// the match is the context query's own column list.
let sessionRowReads = 0;

const counting = new Proxy(connection, {
  apply(target, thisArg, args) {
    const [strings] = args as [TemplateStringsArray];
    if (
      Array.isArray(strings) &&
      strings.join("").includes("id_hash, user_id, session_type")
    ) {
      sessionRowReads += 1;
    }
    return Reflect.apply(
      target as unknown as (...a: unknown[]) => unknown,
      thisArg,
      args,
    );
  },
  get(target, prop) {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as unknown as SQL;

mock.module("../../services/database", () => ({
  get db() {
    return counting;
  },
}));

import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { account } from "./account";

const ORIGIN = process.env.APP_URL as string;

const getAccount = (sessionId?: string) =>
  createBunRequest(`${ORIGIN}/account`, {
    method: "GET",
    ...(sessionId ? { headers: { cookie: `cms_session=${sessionId}` } } : {}),
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
      expect(response.headers.get("location")).toBe("/sign-in");
    });

    test("shows the email and the sign-in method", async () => {
      const user = await seedIdentity(db, "me@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toContain("me@example.com");
      expect(html).toContain("Through the site");
      // The nav's sign-out form is the only one: a second copy in a page card
      // was the duplicate this asserts against.
      expect(html.match(/action="\/auth\/logout"/g)).toHaveLength(1);
    });

    test("mints a CSRF token for the sign-out form", async () => {
      const user = await seedIdentity(db, "tokens@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toMatch(/name="_csrf" value="[^"]+"/);
    });

    test("reads the session once, not once per guard", async () => {
      const user = await seedIdentity(db, "once@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      sessionRowReads = 0;
      await account.index(getAccount(sessionId));

      // One SELECT of the session row. Two would mean the guard and the handler
      // each re-read (and renew) the same session.
      expect(sessionRowReads).toBe(1);
    });

    test("is noindex", async () => {
      const user = await seedIdentity(db, "hidden@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      // Indexing opened so the noindex asserted below is the page's own.
      const html = await withIndexingAllowed(async () =>
        (await account.index(getAccount(sessionId))).text(),
      );

      expect(html).toContain('name="robots" content="noindex, nofollow"');
    });
  });
});
