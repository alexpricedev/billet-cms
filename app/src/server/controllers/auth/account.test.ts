import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
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

import { createCsrfToken, TIME_WINDOW_MINUTES } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { account } from "./account";

const ORIGIN = process.env.APP_URL as string;

const getAccount = (sessionId?: string, path = "/account") =>
  createBunRequest(`${ORIGIN}${path}`, {
    method: "GET",
    ...(sessionId ? { headers: { cookie: `cms_session=${sessionId}` } } : {}),
  });

const postTheme = (
  sessionId: string | undefined,
  fields: Record<string, string>,
) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }

  return createBunRequest(`${ORIGIN}/account/theme`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      ...(sessionId ? { Cookie: `cms_session=${sessionId}` } : {}),
    },
    body: formData,
  });
};

const themeToken = (sessionId: string) =>
  createCsrfToken(sessionId, "POST", "/account/theme");

describe("Account Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterEach(() => {
    setSystemTime();
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

    test("shows the Theme card with the saved theme checked", async () => {
      const user = await seedIdentity(db, "theme-dark@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      await db`
        INSERT INTO cms_user_preferences (user_id, theme)
        VALUES (${user.id}, 'dark')
      `;

      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toContain('action="/account/theme"');
      expect(html).toMatch(/name="theme" value="light"/);
      expect(html).toMatch(/name="theme" value="dark" checked/);
      expect(html).toMatch(/name="theme" value="system"/);
      expect(html).not.toMatch(/value="light" checked/);
      expect(html).not.toMatch(/value="system" checked/);
    });

    test("checks System when the editor has no saved theme", async () => {
      const user = await seedIdentity(db, "theme-default@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      expect(html).toMatch(/value="system" checked/);
      expect(html).not.toMatch(/value="light" checked/);
      expect(html).not.toMatch(/value="dark" checked/);
    });

    test("gives the Theme form its own CSRF token", async () => {
      const user = await seedIdentity(db, "theme-token@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (await account.index(getAccount(sessionId))).text();

      // The nav's sign-out form and the Theme card each carry one.
      expect(html.match(/name="_csrf"/g)).toHaveLength(2);
    });

    test("says the theme was saved", async () => {
      const user = await seedIdentity(db, "theme-saved@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (
        await account.index(getAccount(sessionId, "/account?theme=saved"))
      ).text();

      expect(html).toContain("Theme saved.");
      expect(html).toContain('data-tone="success"');
    });

    test("asks for a valid theme after a bad save", async () => {
      const user = await seedIdentity(db, "theme-invalid@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const html = await (
        await account.index(getAccount(sessionId, "/account?theme=invalid"))
      ).text();

      expect(html).toContain("Choose Light, Dark or System.");
      expect(html).toContain('data-tone="warning"');
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

  describe("POST /account/theme", () => {
    for (const theme of ["light", "dark", "system"] as const) {
      test(`saves ${theme} for the editor`, async () => {
        const user = await seedIdentity(db, `theme-${theme}@example.com`);
        const sessionId = await createAuthenticatedSession(user.id);
        const token = await themeToken(sessionId);

        const response = await account.saveTheme(
          postTheme(sessionId, { _csrf: token, theme }),
        );

        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/account?theme=saved");

        const rows = (await db`
          SELECT theme FROM cms_user_preferences WHERE user_id = ${user.id}
        `) as { theme: string }[];
        expect(rows).toHaveLength(1);
        expect(rows[0].theme).toBe(theme);
      });
    }

    test("refuses a bad value and writes nothing", async () => {
      const user = await seedIdentity(db, "theme-bad@example.com");
      const sessionId = await createAuthenticatedSession(user.id);
      const token = await themeToken(sessionId);

      const response = await account.saveTheme(
        postTheme(sessionId, { _csrf: token, theme: "neon" }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/account?theme=invalid");

      const rows = await db`
        SELECT theme FROM cms_user_preferences WHERE user_id = ${user.id}
      `;
      expect(rows).toHaveLength(0);
    });

    test("a refused value leaves an existing choice alone", async () => {
      const user = await seedIdentity(db, "theme-keep@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      await account.saveTheme(
        postTheme(sessionId, {
          _csrf: await themeToken(sessionId),
          theme: "dark",
        }),
      );

      await account.saveTheme(
        postTheme(sessionId, {
          _csrf: await themeToken(sessionId),
          theme: "neon",
        }),
      );

      const rows = (await db`
        SELECT theme FROM cms_user_preferences WHERE user_id = ${user.id}
      `) as { theme: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].theme).toBe("dark");
    });

    test("rejects a request with no CSRF token", async () => {
      const user = await seedIdentity(db, "theme-no-csrf@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const response = await account.saveTheme(
        postTheme(sessionId, { theme: "dark" }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Invalid CSRF token");

      const rows = await db`
        SELECT theme FROM cms_user_preferences WHERE user_id = ${user.id}
      `;
      expect(rows).toHaveLength(0);
    });

    test("rejects a stale CSRF token without saving", async () => {
      const user = await seedIdentity(db, "theme-stale@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      setSystemTime(new Date(Date.now() - TIME_WINDOW_MINUTES * 3 * 60 * 1000));
      const staleToken = await themeToken(sessionId);
      setSystemTime();

      const response = await account.saveTheme(
        postTheme(sessionId, { _csrf: staleToken, theme: "dark" }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Invalid CSRF token");

      const rows = await db`
        SELECT theme FROM cms_user_preferences WHERE user_id = ${user.id}
      `;
      expect(rows).toHaveLength(0);
    });

    test("redirects a signed-out visitor to sign in", async () => {
      const response = await account.saveTheme(
        postTheme(undefined, { theme: "dark" }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/sign-in");
    });
  });
});
