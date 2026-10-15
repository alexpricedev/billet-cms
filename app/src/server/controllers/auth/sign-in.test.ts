import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { BunRequest, SQL } from "bun";
import {
  createPasswordSiteTables,
  createSiteTables,
  createTempDatabase,
  type TempDatabase,
} from "../../test-utils/migration-helpers";

// The mock is installed before the modules under test are imported, the way
// every service and controller test here does it. Unlike those, the connection
// is not a pool over the suite's database: each suite builds its own fixture
// site. `mock.module` is hoisted above the imports below, and a mocked `db` is
// captured when those imports evaluate — before `beforeAll` has run — so the
// mock exposes a stable proxy that forwards to `connection` once it exists.
let connection: SQL;

/** Callable stand-in the proxy wraps; every call is taken by the `apply` trap. */
function unstubbedDatabase(): never {
  throw new Error("the fixture database was used before it was ready");
}

mock.module("../../services/database", () => ({
  db: new Proxy(unstubbedDatabase, {
    apply(_target, thisArg, args) {
      return Reflect.apply(
        connection as unknown as (...callArgs: unknown[]) => unknown,
        thisArg,
        args,
      );
    },
    get(_target, property) {
      const target = connection as unknown as Record<string | symbol, unknown>;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
}));

import { createEditContentLink } from "@alexpricedev/billet-cms/handoff";
import { handleCmsSignIn } from "@alexpricedev/billet-cms/sign-in";
import { ensureIdentitiesView } from "../../database/identity-view";
import { runMigrations } from "../../database/migrate";
import { clearRateLimitLog } from "../../middleware/rate-limit";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { cleanupTestData } from "../../test-utils/helpers";
import { computeHMAC } from "../../utils/crypto";
import { handoff } from "./handoff";

const CMS_URL = "https://cms.example.com";
const SITE_URL = "https://site.example.com";
const APP_URL = process.env.APP_URL as string;

/** The site's own session cookie, set by its login and read here. */
const SITE_SESSION_COOKIE = "site_session";

/** The two site shapes the CMS has to work against. */
type Mode = "magic-link" | "password";

const MODES: Mode[] = ["magic-link", "password"];

// A password-mode site user's stored credential. Deliberately not a usable
// hash: if any part of the CMS read or wrote it, the assertions would see it
// change.
const PASSWORD_HASH = "argon2id$test$never-verified";

interface SiteUser {
  id: string;
  email: string;
  role: string;
}

const tokenFrom = (location: string): string => {
  const token = new URL(location).searchParams.get("token");
  if (!token) throw new Error(`no token in ${location}`);
  return token;
};

const cookieValue = (req: BunRequest, name: string): string => {
  const match = findSetCookie(req, name)?.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`no ${name} cookie was set`);
  return match[1];
};

/** GET /handoff with a token, returning the confirm page and its form fields. */
const openHandoff = async (token: string) => {
  const req = createBunRequest(
    `${APP_URL}/handoff?token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
  const res = await handoff.index(req);
  const html = res.status === 200 ? await res.text() : "";
  return {
    req,
    res,
    html,
    csrfToken: html.match(/name="_csrf" value="([^"]+)"/)?.[1],
    sessionId: cookieValue(req, "cms_session"),
  };
};

/** POST /handoff — the click that spends the token. */
const submitHandoff = async (opts: {
  token: string;
  csrfToken?: string;
  sessionId: string;
}) => {
  const req = createBunRequest(`${APP_URL}/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: APP_URL,
      cookie: `cms_session=${opts.sessionId}`,
    },
    body: new URLSearchParams({
      _csrf: opts.csrfToken ?? "",
      token: opts.token,
    }).toString(),
  });
  return { req, res: await handoff.create(req) };
};

/** The plugin route, with the site's own user lookup stubbed. */
const requestSignIn = (getUserId: () => string | null) =>
  handleCmsSignIn(new Request(`${SITE_URL}/cms/sign-in`), {
    sql: connection,
    cmsUrl: CMS_URL,
    getUserId,
  });

const readSiteSessionCookie = (req: Request): string | null => {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SITE_SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
};

/**
 * Write a real site session for `userId`, the way the site's own login would,
 * and return the raw cookie value. The row lives in the site's `sessions`
 * table, hashed exactly as Billet hashes a session id, so the lookup below is
 * the site's real one rather than a stub.
 */
const createSiteSession = async (userId: string): Promise<string> => {
  const rawSessionId = crypto.randomUUID();
  await connection`
    INSERT INTO sessions (id_hash, user_id, session_type, expires_at)
    VALUES (
      ${computeHMAC(rawSessionId)},
      ${userId},
      'authenticated',
      ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}
    )
  `;
  return rawSessionId;
};

/**
 * The site's session lookup, wired to the plugin the way a real site wires it:
 * the cookie names a session row, and the row names the account. A missing,
 * unknown or expired session is signed out.
 */
const siteUserIdFromSession = async (req: Request): Promise<string | null> => {
  const rawSessionId = readSiteSessionCookie(req);
  if (!rawSessionId) return null;
  const rows = await connection`
    SELECT s.user_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ${computeHMAC(rawSessionId)}
      AND s.expires_at > CURRENT_TIMESTAMP
  `;
  return (rows[0]?.user_id as string) ?? null;
};

/**
 * The plugin route reached with a real site session: no stub, the request
 * carries the site's cookie and the lookup reads the session row back.
 */
const requestSignInWithSession = (rawSessionId: string) =>
  handleCmsSignIn(
    new Request(`${SITE_URL}/cms/sign-in`, {
      headers: { cookie: `${SITE_SESSION_COOKIE}=${rawSessionId}` },
    }),
    { sql: connection, cmsUrl: CMS_URL, getUserId: siteUserIdFromSession },
  );

/** Spend the token the plugin minted: open the confirm page, then submit it. */
const spendHandoff = async (pluginResponse: Response) => {
  expect(pluginResponse.status).toBe(303);
  const token = tokenFrom(pluginResponse.headers.get("location") as string);

  const opened = await openHandoff(token);
  const { res } = await submitHandoff({
    token,
    csrfToken: opened.csrfToken,
    sessionId: opened.sessionId,
  });
  return { token, opened, res };
};

/** The whole journey: the plugin route mints, then the CMS spends. */
const signInThroughSite = async (userId: string) => {
  const pluginResponse = await requestSignIn(() => userId);
  const { opened, res } = await spendHandoff(pluginResponse);
  return { pluginResponse, opened, res };
};

for (const mode of MODES) {
  describe(`CMS sign-in against a ${mode} site`, () => {
    let temp: TempDatabase;

    /**
     * Seed a site user the way this mode has them: password mode carries the
     * hash the site's own sign-in wrote; magic-link mode's `users` has no
     * credential column at all.
     */
    const seedSiteAdmin = async (
      email: string,
      role = "admin",
    ): Promise<SiteUser> => {
      const rows =
        mode === "password"
          ? ((await connection`
              INSERT INTO users (email, role, password_hash)
              VALUES (${email.toLowerCase()}, ${role}, ${PASSWORD_HASH})
              RETURNING id, email, role
            `) as SiteUser[])
          : ((await connection`
              INSERT INTO users (email, role)
              VALUES (${email.toLowerCase()}, ${role})
              RETURNING id, email, role
            `) as SiteUser[]);
      return rows[0];
    };

    beforeAll(async () => {
      temp = await createTempDatabase(`auth-signin-${mode}`);
      // One connection: the whole journey runs sequentially, so a pool of three
      // only adds to the connection pressure `--parallel` already puts on the
      // shared Postgres.
      connection = temp.openOne();

      // The site's tables first, as its own deploy would have made them, then
      // the CMS's migrations, then the `cms_identities` view over the site's
      // `users`. The two modes differ only in the site's `users` shape.
      if (mode === "password") {
        await createPasswordSiteTables(connection);
      } else {
        await createSiteTables(connection);
      }
      await runMigrations(connection);
      await ensureIdentitiesView(connection);
    });

    afterAll(async () => {
      await temp.drop();
      mock.restore();
    });

    beforeEach(async () => {
      await cleanupTestData(connection);
      // The auth rate-limit budget is global state; clear it so the many handoff
      // posts across this file's cases don't spend each other's.
      clearRateLimitLog();
    });

    test("signed in on the site: straight into the CMS with a session", async () => {
      const admin = await seedSiteAdmin("admin@example.com");

      const { pluginResponse, res } = await signInThroughSite(admin.id);

      // The plugin handed the browser to the CMS with a single-use token.
      const token = tokenFrom(pluginResponse.headers.get("location") as string);
      expect(
        pluginResponse.headers
          .get("location")
          ?.startsWith(`${CMS_URL}/handoff?token=`),
      ).toBe(true);

      // The CMS spent it and started the admin's session.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/cms");

      const sessions = await connection`
        SELECT user_id FROM cms_sessions WHERE session_type = 'authenticated'
      `;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].user_id).toBe(admin.id);

      // The token is spent, so a second click signs nobody in.
      const again = await openHandoff(token);
      const second = await submitHandoff({
        token,
        csrfToken: again.csrfToken,
        sessionId: again.sessionId,
      });
      expect(second.res.headers.get("location")).toBe("/sign-in");
    });

    test("signed out on the site: to the site's login, then back into the CMS", async () => {
      const admin = await seedSiteAdmin("admin@example.com");

      // Nobody is signed in: the route sends them to the site's own login with
      // a `next` back to itself.
      const signedOut = await requestSignIn(() => null);
      expect(signedOut.status).toBe(303);
      expect(signedOut.headers.get("location")).toBe(
        `/login?next=${encodeURIComponent("/cms/sign-in")}`,
      );

      // The site's own login has now run (password or magic link — the route
      // doesn't care which) and left a real site session behind. Re-requesting
      // the `next` continues into the CMS, resolving the site user through that
      // session rather than a stub.
      const rawSessionId = await createSiteSession(admin.id);
      const pluginResponse = await requestSignInWithSession(rawSessionId);
      expect(pluginResponse.status).toBe(303);
      expect(
        pluginResponse.headers
          .get("location")
          ?.startsWith(`${CMS_URL}/handoff?token=`),
      ).toBe(true);

      const { res } = await spendHandoff(pluginResponse);
      expect(res.headers.get("location")).toBe("/cms");

      const sessions = await connection`
        SELECT user_id FROM cms_sessions WHERE session_type = 'authenticated'
      `;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].user_id).toBe(admin.id);
    });

    test("a handoff token minted by the site's sign-in route expires unspent", async () => {
      const admin = await seedSiteAdmin("admin@example.com");

      // The plugin mints a real token through a real site session, then the
      // 60-second window passes before the browser comes back to spend it.
      const rawSessionId = await createSiteSession(admin.id);
      const pluginResponse = await requestSignInWithSession(rawSessionId);

      await connection`
        UPDATE cms_handoff_tokens
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE user_id = ${admin.id}
      `;

      const { res } = await spendHandoff(pluginResponse);

      // The expired token signs nobody in: back to sign-in, no session started.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
      expect(
        await connection`
          SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL
        `,
      ).toHaveLength(0);

      // And it is not left claimable: the row is still unspent but expired.
      const rows = await connection`
        SELECT used_at, expires_at FROM cms_handoff_tokens WHERE user_id = ${admin.id}
      `;
      expect(rows[0].used_at).toBeNull();
      expect(new Date(rows[0].expires_at as string).getTime()).toBeLessThan(
        Date.now(),
      );
    });

    test("refuses a signed-in site user who is not an identity, writing nothing", async () => {
      const member = await seedSiteAdmin("member@example.com", "user");

      const res = await requestSignIn(() => member.id);

      expect(res.status).toBe(403);
      expect(await connection`SELECT id FROM cms_handoff_tokens`).toHaveLength(
        0,
      );
      expect(
        await connection`
          SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL
        `,
      ).toHaveLength(0);
    });

    test("a handoff token minted for a demoted admin no longer signs them in", async () => {
      const admin = await seedSiteAdmin("demoted@example.com");

      const link = await createEditContentLink(connection, {
        userId: admin.id,
        cmsUrl: CMS_URL,
      });
      if (!link) throw new Error("no handoff link");
      const token = tokenFrom(link);

      // The site demotes them before the click.
      await connection`UPDATE users SET role = 'user' WHERE id = ${admin.id}`;

      const opened = await openHandoff(token);
      const { res } = await submitHandoff({
        token,
        csrfToken: opened.csrfToken,
        sessionId: opened.sessionId,
      });

      // The CMS re-reads the identity when it spends the token, so it refuses.
      expect(res.headers.get("location")).toBe("/sign-in");
      expect(
        await connection`
          SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL
        `,
      ).toHaveLength(0);
    });

    test("the Edit content handoff still works", async () => {
      const admin = await seedSiteAdmin("editor@example.com");

      const link = await createEditContentLink(connection, {
        userId: admin.id,
        cmsUrl: CMS_URL,
      });
      expect(link).toStartWith(`${CMS_URL}/handoff?token=`);

      const token = tokenFrom(link as string);
      const opened = await openHandoff(token);
      const { res } = await submitHandoff({
        token,
        csrfToken: opened.csrfToken,
        sessionId: opened.sessionId,
      });

      expect(res.headers.get("location")).toBe("/cms");
    });

    test("the CMS never reads or writes the site's password data", async () => {
      const admin = await seedSiteAdmin("secret@example.com");
      const before = await connection`
        SELECT email, role FROM users WHERE id = ${admin.id}
      `;

      await signInThroughSite(admin.id);

      expect(
        await connection`SELECT email, role FROM users WHERE id = ${admin.id}`,
      ).toEqual(before);

      if (mode === "password") {
        // The stored hash is byte-for-byte what the site wrote.
        const rows = (await connection`
          SELECT password_hash FROM users WHERE id = ${admin.id}
        `) as { password_hash: string }[];
        expect(rows[0].password_hash).toBe(PASSWORD_HASH);
      }

      // And no CMS table carries a password column at all.
      const columns = await connection`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name LIKE 'cms_%'
          AND column_name ILIKE '%password%'
      `;
      expect(columns).toEqual([]);
    });
  });
}
