import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { clearRateLimitLog } from "../../middleware/rate-limit";
import {
  clearUsedChallenges,
  HONEYPOT_FIELD,
  issueChallenge,
} from "../../services/captcha";
import type { LoginState } from "../../templates/login";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { stateHelpers } from "../../utils/state";

// Solve a challenge the way the client would, for the captcha-enabled tests.
const solveChallenge = (
  challenge: ReturnType<typeof issueChallenge>,
): string => {
  let answer = 0;
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (
      createHash("sha256").update(`${challenge.salt}${n}`).digest("hex") ===
      challenge.challenge
    ) {
      answer = n;
      break;
    }
  }
  return Buffer.from(
    JSON.stringify({
      salt: challenge.salt,
      challenge: challenge.challenge,
      expires: challenge.expires,
      signature: challenge.signature,
      number: answer,
    }),
  ).toString("base64");
};

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../../services/database";
import {
  createAuthenticatedSession,
  createGuestSession,
} from "../../services/sessions";
import { authFormPost, staleCsrfToken } from "../../test-utils/auth-form";
import { login } from "./login";

/**
 * POST /login the way the browser does, returning both the request (for its
 * Set-Cookie headers) and the response.
 */
const postEmail = async (email: string) => {
  const formData = new FormData();
  formData.append("email", email);

  const request = await authFormPost("/login", formData);

  return { request, response: await login.create(request) };
};

describe("Login Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    // Guards share process-wide state; reset so tests don't leak into each other.
    clearRateLimitLog();
    clearUsedChallenges();
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("GET /login", () => {
    test("renders login page for unauthenticated user", async () => {
      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
      });
      const response = await login.index(request);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html");
      expect(html).toContain("Sign in to your account");
      expect(html).toContain('name="email"');
      expect(html).toContain("Send magic link");
    });

    test("shows success message when state=email-sent", async () => {
      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
      });

      // Set flash cookie before calling the handler
      const { setFlash } = stateHelpers<LoginState>();
      setFlash(request, { state: "email-sent" });

      const response = await login.index(request);
      const html = await response.text();

      expect(html).toContain("Check your email!");
      expect(html).toContain("We've sent you a magic link");
    });

    test("shows error message when error is provided", async () => {
      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
      });

      // Set flash cookie before calling the handler
      const { setFlash } = stateHelpers<LoginState>();
      setFlash(request, {
        state: "validation-error",
        error: "Invalid email",
      });

      const response = await login.index(request);
      const html = await response.text();

      expect(html).toContain("Invalid email");
    });

    // /auth/callback and the other single-use-link dead ends redirect here with
    // ?error=; for a while the page dropped it and showed a pristine form.
    test("renders the error a redirect left in the query string", async () => {
      const request = createBunRequest(
        "http://localhost:3000/login?error=Invalid%20or%20expired%20token",
        { method: "GET" },
      );

      const html = await (await login.index(request)).text();

      expect(html).toContain("Invalid or expired token");
    });

    test("prefers flash state over the query string", async () => {
      const request = createBunRequest(
        "http://localhost:3000/login?error=from%20the%20query",
        { method: "GET" },
      );

      const { setFlash } = stateHelpers<LoginState>();
      setFlash(request, { state: "validation-error", error: "from the flash" });

      const html = await (await login.index(request)).text();

      expect(html).toContain("from the flash");
      expect(html).not.toContain("from the query");
    });

    describe("the console magic-link hint", () => {
      const ORIGINAL_PROVIDER = process.env.EMAIL_PROVIDER;

      afterAll(() => {
        if (ORIGINAL_PROVIDER === undefined) delete process.env.EMAIL_PROVIDER;
        else process.env.EMAIL_PROVIDER = ORIGINAL_PROVIDER;
      });

      const sentPage = async () => {
        const request = createBunRequest("http://localhost:3000/login", {
          method: "GET",
        });
        const { setFlash } = stateHelpers<LoginState>();
        setFlash(request, { state: "email-sent" });

        return (await login.index(request)).text();
      };

      test("appears when mail goes to the console", async () => {
        process.env.EMAIL_PROVIDER = "console";

        expect(await sentPage()).toContain("Check the server console");
      });

      // Anywhere else the link really is in an inbox, and the hint points at a
      // terminal the reader has no way to see.
      test("is absent for a real provider", async () => {
        process.env.EMAIL_PROVIDER = "resend";

        expect(await sentPage()).not.toContain("Check the server console");
      });
    });

    test("redirects authenticated user to home", async () => {
      const user = await seedIdentity(db, "already-in@example.com");
      const sessionId = await createAuthenticatedSession(user.id);

      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
        headers: { cookie: `cms_session=${sessionId}` },
      });

      const response = await login.index(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    });

    // The token the form posts binds to this session, so the cookie has to go
    // out with the page. Without it the browser posts a token against nothing.
    test("renders a CSRF field and sets the guest session cookie", async () => {
      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
      });

      const html = await (await login.index(request)).text();

      expect(html).toContain('name="_csrf"');
      expect(findSetCookie(request, "cms_session")).toBeDefined();

      const sessions = await db`SELECT session_type FROM cms_sessions`;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].session_type).toBe("guest");
    });

    // The old code called the middleware for its redirect and threw the
    // context away — one orphan session row per anonymous page view.
    test("reuses the session it was given rather than minting another", async () => {
      const sessionId = await createGuestSession();

      const request = createBunRequest("http://localhost:3000/login", {
        method: "GET",
        headers: { cookie: `cms_session=${sessionId}` },
      });

      await login.index(request);

      expect(await db`SELECT id_hash FROM cms_sessions`).toHaveLength(1);
    });
  });

  describe("POST /login", () => {
    test("mints a magic link for an existing user", async () => {
      const user = await seedIdentity(db, "test@example.com");

      const { request, response } = await postEmail("test@example.com");

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");

      const setCookie = findSetCookie(request, "flash_state");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("email-sent");

      // The account was already there: sign-in mints a token, it does not
      // provision a new row.
      expect(await db`SELECT id FROM users`).toHaveLength(1);

      const tokens = await db`
        SELECT id, user_id, type, expires_at
        FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;
      expect(tokens).toHaveLength(1);
    });

    test("normalizes the email it looks up", async () => {
      const user = await seedIdentity(db, "test@example.com");

      const { request } = await postEmail("Test@Example.COM");

      expect(findSetCookie(request, "flash_state")).toContain("email-sent");
      expect(await db`SELECT id FROM users`).toHaveLength(1);

      const tokens = await db`SELECT user_id FROM cms_user_tokens`;
      expect(tokens).toHaveLength(1);
      expect(tokens[0].user_id).toBe(user.id);
    });

    // Invite-only: an unknown address must not be provisioned, and the response
    // must be indistinguishable from the one a known address gets, or the form
    // becomes an account-enumeration oracle.
    test("an unknown email creates no user and no token, and looks identical to a known one", async () => {
      const known = await seedIdentity(db, "known@example.com");

      const knownPost = await postEmail("known@example.com");
      const unknownPost = await postEmail("unknown@example.com");

      // Same status, same redirect, byte-for-byte the same flash cookie.
      expect(unknownPost.response.status).toBe(knownPost.response.status);
      expect(unknownPost.response.headers.get("location")).toBe(
        knownPost.response.headers.get("location"),
      );
      expect(findSetCookie(unknownPost.request, "flash_state")).toBe(
        findSetCookie(knownPost.request, "flash_state"),
      );

      // The unknown address got no account, no token and no session.
      expect(
        await db`SELECT id FROM users WHERE email = 'unknown@example.com'`,
      ).toHaveLength(0);
      expect(findSetCookie(unknownPost.request, "cms_session")).toBeUndefined();
      const sessions =
        await db`SELECT user_id FROM cms_sessions WHERE user_id IS NOT NULL`;
      expect(sessions).toHaveLength(0);

      // The known address still got its link.
      const tokens = await db`
        SELECT user_id FROM cms_user_tokens WHERE user_id = ${known.id}
      `;
      expect(tokens).toHaveLength(1);
    });

    // A site user the view keeps out — an editor the site has not promoted, or
    // a plain member — is a non-identity: no token, no email, no row written,
    // and the same response a signed-in admin gets.
    test("refuses a non-admin with the same response and no token", async () => {
      await seedIdentity(db, "member@example.com", "user");
      const before = await db`SELECT id FROM users`;

      const { request, response } = await postEmail("member@example.com");

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(findSetCookie(request, "flash_state")).toContain("email-sent");

      expect(await db`SELECT id FROM users`).toHaveLength(before.length);
      expect(await db`SELECT id FROM cms_user_tokens`).toHaveLength(0);
    });

    test("redirects with error for invalid email", async () => {
      const formData = new FormData();
      formData.append("email", "not-an-email");

      const request = await authFormPost("/login", formData);

      const response = await login.create(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");

      const setCookie = findSetCookie(request, "flash_state");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("validation-error");
      expect(setCookie).toContain("Invalid email address");
    });

    test("redirects with error for missing email", async () => {
      const formData = new FormData();

      const request = await authFormPost("/login", formData);

      const response = await login.create(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");

      const setCookie = findSetCookie(request, "flash_state");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("validation-error");
      expect(setCookie).toContain("Invalid email address");
    });

    test("reuses existing identity for same email", async () => {
      const user = await seedIdentity(db, "existing@example.com");

      const formData = new FormData();
      formData.append("email", "existing@example.com");

      const request = await authFormPost("/login", formData);

      await login.create(request);

      // Should still be only one site user
      const users =
        await db`SELECT id FROM users WHERE email = 'existing@example.com'`;
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(user.id);

      // But should have created a new token
      const tokens = await db`
        SELECT id FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;
      expect(tokens).toHaveLength(1);
    });
  });

  // A forged POST /login signs the victim into the *attacker's* account, and
  // they carry on working in it. These four cases are the guard against that.
  describe("POST /login CSRF", () => {
    test("refuses a post with no token, creating nothing", async () => {
      const formData = new FormData();
      formData.append("email", "notoken@example.com");

      const response = await login.create(
        await authFormPost("/login", formData, { csrf: false }),
      );

      expect(response.status).toBe(403);
      expect(
        await db`SELECT id FROM users WHERE email = 'notoken@example.com'`,
      ).toHaveLength(0);
    });

    test("refuses a forged token", async () => {
      const formData = new FormData();
      formData.append("email", "forged@example.com");

      const response = await login.create(
        await authFormPost("/login", formData, { csrf: "nonce.notarealtoken" }),
      );

      expect(response.status).toBe(403);
      expect(
        await db`SELECT id FROM users WHERE email = 'forged@example.com'`,
      ).toHaveLength(0);
    });

    // The cross-origin check runs before the token is even looked at, which is
    // the point: a valid token stolen from the page must not travel.
    test("refuses a post from another origin", async () => {
      const formData = new FormData();
      formData.append("email", "crossorigin@example.com");

      const response = await login.create(
        await authFormPost("/login", formData, {
          origin: "https://evil.example",
        }),
      );

      expect(response.status).toBe(403);
      expect(
        await db`SELECT id FROM users WHERE email = 'crossorigin@example.com'`,
      ).toHaveLength(0);
    });

    // An old tab, not an attack: the address survives and the redirect lands
    // on a page that mints a fresh token. The link is still not sent.
    test("recovers from a stale but authentic token", async () => {
      const sessionId = await createGuestSession();
      const formData = new FormData();
      formData.append("email", "staletab@example.com");

      const request = await authFormPost("/login", formData, {
        sessionId,
        csrf: await staleCsrfToken(sessionId, "/login"),
      });
      const response = await login.create(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");

      const flash = findSetCookie(request, "flash_state");
      expect(flash).toContain("validation-error");
      expect(decodeURIComponent(flash as string)).toContain(
        "staletab@example.com",
      );

      expect(
        await db`SELECT id FROM users WHERE email = 'staletab@example.com'`,
      ).toHaveLength(0);
    });
  });

  describe("POST /login bot defense", () => {
    test("silently discards a submission with the honeypot filled", async () => {
      const formData = new FormData();
      formData.append("email", "bot@example.com");
      formData.append(HONEYPOT_FIELD, "http://spam.example");

      const request = await authFormPost("/login", formData);

      const response = await login.create(request);

      // Feigns success so the bot gets no signal...
      expect(response.status).toBe(303);
      const setCookie = findSetCookie(request, "flash_state");
      expect(setCookie).toContain("email-sent");

      // ...but creates no user and issues no magic link.
      const users =
        await db`SELECT id FROM users WHERE email = 'bot@example.com'`;
      expect(users).toHaveLength(0);
    });

    test("returns 429 once the per-IP rate limit is exceeded", async () => {
      const send = async () => {
        const formData = new FormData();
        formData.append("email", "flood@example.com");
        return login.create(await authFormPost("/login", formData));
      };

      // Limit is 5 per window; the 6th request is throttled.
      for (let i = 0; i < 5; i++) {
        expect((await send()).status).toBe(303);
      }
      expect((await send()).status).toBe(429);
    });

    describe("with captcha enabled", () => {
      const original = process.env.CAPTCHA_ENABLED;
      const originalDifficulty = process.env.CAPTCHA_DIFFICULTY;

      beforeEach(() => {
        process.env.CAPTCHA_ENABLED = "true";
        process.env.CAPTCHA_DIFFICULTY = "2000";
      });

      afterAll(() => {
        if (original === undefined) delete process.env.CAPTCHA_ENABLED;
        else process.env.CAPTCHA_ENABLED = original;
        if (originalDifficulty === undefined)
          delete process.env.CAPTCHA_DIFFICULTY;
        else process.env.CAPTCHA_DIFFICULTY = originalDifficulty;
      });

      test("rejects a missing or invalid captcha solution", async () => {
        const formData = new FormData();
        formData.append("email", "human@example.com");
        // No captcha_solution field.

        const request = await authFormPost("/login", formData);

        const response = await login.create(request);

        expect(response.status).toBe(303);
        const setCookie = findSetCookie(request, "flash_state");
        expect(setCookie).toContain("validation-error");
        expect(setCookie).toContain("Verification failed");

        const users =
          await db`SELECT id FROM users WHERE email = 'human@example.com'`;
        expect(users).toHaveLength(0);
      });

      test("issues the magic link when the captcha is solved", async () => {
        const user = await seedIdentity(db, "human@example.com");

        const formData = new FormData();
        formData.append("email", "human@example.com");
        formData.append("captcha_solution", solveChallenge(issueChallenge()));

        const request = await authFormPost("/login", formData);

        const response = await login.create(request);

        expect(response.status).toBe(303);
        const setCookie = findSetCookie(request, "flash_state");
        expect(setCookie).toContain("email-sent");

        expect(await db`SELECT id FROM users`).toHaveLength(1);
        const tokens = await db`
          SELECT id FROM cms_user_tokens WHERE user_id = ${user.id}
        `;
        expect(tokens).toHaveLength(1);
      });
    });
  });
});
