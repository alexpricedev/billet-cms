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
  createTempDatabase,
  type TempDatabase,
} from "../../test-utils/migration-helpers";

// The mock is installed before the modules under test are imported, the way
// every service and controller test here does it. Unlike those, the connection
// is not a pool over the suite's database: this file builds its own
// password-mode fixture site. `mock.module` is hoisted above the imports below,
// and a mocked `db` is captured when those imports evaluate — before
// `beforeAll` has run — so the mock exposes a stable proxy that forwards to
// `connection` once it exists, instead of reading it once and reading
// `undefined`.
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

import {
  createEditContentLink,
  hashHandoffToken,
} from "@alexpricedev/billet-cms/handoff";
import { ensureIdentitiesView } from "../../database/identity-view";
import { runMigrations } from "../../database/migrate";
import { clearRateLimitLog } from "../../middleware/rate-limit";
import { createMagicLink, verifyMagicLink } from "../../services/auth";
import { redeemHandoffToken } from "../../services/handoff";
import { authFormPost } from "../../test-utils/auth-form";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { cleanupTestData } from "../../test-utils/helpers";
import { handoff } from "./handoff";
import { login, whenMagicLinkSettled } from "./login";

const ORIGIN = process.env.APP_URL as string;

// A password-mode site user's stored credential. Deliberately not a usable
// hash: if any part of the CMS validated it, sign-in would fail or the
// assertions below would see it change. Nothing does.
const PASSWORD_HASH = "argon2id$test$never-verified";

interface SiteUser {
  id: string;
  email: string;
  role: string;
  password_hash: string | null;
}

/** The credential columns `readUser` compares before and after a sign-in. */
type StoredCredential = Pick<SiteUser, "email" | "role" | "password_hash">;

const cookieValue = (req: BunRequest, name: string): string => {
  const match = findSetCookie(req, name)?.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`no ${name} cookie was set`);
  return match[1];
};

/**
 * Seed a site user the way password mode has it: the row carries the argon2id
 * hash the site's own sign-in wrote, and the CMS is supposed to never see it.
 */
const seedPasswordUser = async (
  email: string,
  options: { role?: string; passwordHash?: string | null } = {},
): Promise<SiteUser> => {
  const role = options.role ?? "admin";
  const hash =
    options.passwordHash === undefined ? PASSWORD_HASH : options.passwordHash;
  const rows = (await connection`
    INSERT INTO users (email, role, password_hash, email_verified_at)
    VALUES (${email.toLowerCase()}, ${role}, ${hash}, CURRENT_TIMESTAMP)
    RETURNING id, email, role, password_hash
  `) as SiteUser[];
  return rows[0];
};

const readUser = async (id: string): Promise<StoredCredential> => {
  const rows = (await connection`
    SELECT email, role, password_hash
    FROM users
    WHERE id = ${id}
  `) as StoredCredential[];
  return rows[0];
};

/** GET /handoff with a token, returning the confirm page and its form fields. */
const openHandoff = async (token: string) => {
  const req = createBunRequest(
    `${ORIGIN}/handoff?token=${encodeURIComponent(token)}`,
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
  const req = createBunRequest(`${ORIGIN}/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      cookie: `cms_session=${opts.sessionId}`,
    },
    body: new URLSearchParams({
      _csrf: opts.csrfToken ?? "",
      token: opts.token,
    }).toString(),
  });
  return { req, res: await handoff.create(req) };
};

const postLogin = async (email: string) => {
  const formData = new FormData();
  formData.append("email", email);

  const request = await authFormPost("/login", formData);
  const response = await login.create(request);
  // Minting and sending run off the request path on purpose; wait for the work
  // so the assertions below see it.
  await whenMagicLinkSettled();

  return { request, response };
};

describe("CMS sign-in against a password-mode site", () => {
  let temp: TempDatabase;

  beforeAll(async () => {
    temp = await createTempDatabase("auth-password-mode");
    connection = temp.open();

    // The site's tables first, as its own deploy would have made them, then the
    // CMS's migrations, then the `cms_identities` view the CMS builds over the
    // site's `users`. `AUTH_MODE=password` is the site's own switch — the CMS
    // never reads it — so the fixture's whole job is to give `users` the shape
    // password mode leaves it in: the credential columns a magic-link site
    // doesn't fill.
    await createPasswordSiteTables(connection);
    await runMigrations(connection);
    await ensureIdentitiesView(connection);
  });

  afterAll(async () => {
    await temp.drop();
    mock.restore();
  });

  beforeEach(async () => {
    await cleanupTestData(connection);
    // The login route is rate limited through process-wide state; reset it so
    // one test's posts can't throttle the next.
    clearRateLimitLog();
  });

  describe("item 1 — an admin signs in by email (magic link)", () => {
    test("the /login route mints a magic link for an admin", async () => {
      const admin = await seedPasswordUser("admin@example.com");

      const { response } = await postLogin("admin@example.com");

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");

      const tokens = await connection`
        SELECT user_id FROM cms_user_tokens WHERE user_id = ${admin.id}
      `;
      expect(tokens).toHaveLength(1);
    });

    test("the link signs the admin in", async () => {
      await seedPasswordUser("admin@example.com");

      const link = await createMagicLink("admin@example.com");
      if (!link) throw new Error("no magic link for the admin");

      const result = await verifyMagicLink(link.rawToken);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.user.email).toBe("admin@example.com");
      expect(result.user.role).toBe("admin");
    });
  });

  describe("item 2 — the Edit content handoff", () => {
    test("signs in an admin who signed in to the site with a password", async () => {
      const admin = await seedPasswordUser("admin@example.com");

      // The site's half: an admin already signed in to the site (with a
      // password) is rendered the Edit content link.
      const link = await createEditContentLink(connection, {
        userId: admin.id,
        cmsUrl: "https://cms.example.com",
      });
      if (!link) throw new Error("no handoff link for the admin");
      const token = new URL(link).searchParams.get("token");
      if (!token) throw new Error("no token in the handoff link");

      // The CMS's half: GET confirms without spending, POST spends.
      const opened = await openHandoff(token);
      expect(opened.res.status).toBe(200);

      const { res } = await submitHandoff({
        token,
        csrfToken: opened.csrfToken,
        sessionId: opened.sessionId,
      });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/cms");

      const sessions = await connection`
        SELECT user_id FROM cms_sessions WHERE session_type = 'authenticated'
      `;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].user_id).toBe(admin.id);
    });
  });

  describe("item 3 — a non-admin is refused by both routes", () => {
    test("the CMS magic-link route refuses them, writing nothing", async () => {
      await seedPasswordUser("member@example.com", { role: "user" });

      const { request, response } = await postLogin("member@example.com");

      // The same "check your email" page an admin gets, so the form can't be
      // used to sort admins from non-admins.
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(findSetCookie(request, "flash_state")).toContain("email-sent");

      // But no token, no session and no extra `users` row.
      expect(await connection`SELECT id FROM cms_user_tokens`).toHaveLength(0);
      expect(
        await connection`
          SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL
        `,
      ).toHaveLength(0);
      expect(await connection`SELECT id FROM users`).toHaveLength(1);
    });

    test("the Edit content handoff refuses them", async () => {
      const member = await seedPasswordUser("member@example.com", {
        role: "user",
      });

      // The site's helper hides the link for a non-identity...
      const hidden = await createEditContentLink(connection, {
        userId: member.id,
        cmsUrl: "https://cms.example.com",
      });
      expect(hidden).toBeNull();

      // ...and a handoff token that names them anyway — a link minted before
      // the site demoted them — signs nobody in. The CMS re-reads the identity
      // when it spends the token, so the route itself refuses, not the helper.
      const rawToken = "stale-handoff-token";
      await connection`
        INSERT INTO cms_handoff_tokens (user_id, token_hash, expires_at)
        VALUES (
          ${member.id},
          ${hashHandoffToken(rawToken)},
          CURRENT_TIMESTAMP + INTERVAL '1 minute'
        )
      `;

      const opened = await openHandoff(rawToken);
      const { res } = await submitHandoff({
        token: rawToken,
        csrfToken: opened.csrfToken,
        sessionId: opened.sessionId,
      });

      expect(res.status).toBe(303);
      expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
        "can no longer sign in",
      );
      expect(
        await connection`
          SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL
        `,
      ).toHaveLength(0);
    });
  });

  describe("item 4 — the credential is never read or written", () => {
    test("cms_identities is built over the password users table", async () => {
      const columns = await connection`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'cms_identities'
        ORDER BY column_name
      `;
      expect(
        (columns as { column_name: string }[]).map((c) => c.column_name),
      ).toEqual(["email", "id", "role"]);
    });

    test("sign-in and the handoff leave the stored hash untouched", async () => {
      const admin = await seedPasswordUser("admin@example.com");
      const before = await readUser(admin.id);

      const link = await createMagicLink("admin@example.com");
      if (!link) throw new Error("no magic link for the admin");
      await verifyMagicLink(link.rawToken);

      const editLink = await createEditContentLink(connection, {
        userId: admin.id,
        cmsUrl: "https://cms.example.com",
      });
      if (!editLink) throw new Error("no handoff link for the admin");
      const token = new URL(editLink).searchParams.get("token");
      if (!token) throw new Error("no token in the handoff link");
      expect((await redeemHandoffToken(token)).success).toBe(true);

      expect(await readUser(admin.id)).toEqual(before);
    });

    test("no CMS table carries a password column", async () => {
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
});
