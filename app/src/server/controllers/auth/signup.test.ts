import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearRateLimitLog } from "../../middleware/rate-limit";
import { clearUsedChallenges, HONEYPOT_FIELD } from "../../services/captcha";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, withIndexingAllowed } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../../services/database";
import { createGuestSession } from "../../services/sessions";
import type { SignupState } from "../../templates/signup";
import { authFormPost, staleCsrfToken } from "../../test-utils/auth-form";
import { stateHelpers } from "../../utils/state";
import { signup } from "./signup";

const post = async (
  fields: Record<string, string>,
  options: Parameters<typeof authFormPost>[2] = {},
) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return authFormPost("/signup", formData, options);
};

const get = () =>
  createBunRequest("http://localhost:3000/signup", { method: "GET" });

describe("Signup Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    clearRateLimitLog();
    clearUsedChallenges();
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("magic-link mode", () => {
    const originalMode = process.env.AUTH_MODE;

    beforeEach(() => {
      delete process.env.AUTH_MODE;
    });

    afterAll(() => {
      if (originalMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = originalMode;
    });

    test("renders sign-up wording with no password field", async () => {
      const html = await (await signup.index(get())).text();

      expect(html).toContain("Create your account");
      expect(html).toContain("Send sign-up link");
      expect(html).not.toContain('name="password"');
    });

    // Under the indexing switch, because the page's own noindex is what this
    // is about — with the site-wide default closed every page carries the tag
    // and the assertion would survive the prop being deleted.
    test("is noindex and links back to sign-in", async () => {
      const html = await withIndexingAllowed(async () =>
        (await signup.index(get())).text(),
      );

      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(html).toContain('href="/login"');
    });

    test("creates the user and a magic link token", async () => {
      const request = await post({ email: "joiner@example.com" });
      const response = await signup.create(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/signup");
      expect(findSetCookie(request, "flash_state")).toContain("email-sent");

      const users =
        await db`SELECT id FROM cms_users WHERE email = 'joiner@example.com'`;
      expect(users).toHaveLength(1);

      const tokens = await db`
        SELECT type FROM cms_user_tokens WHERE user_id = ${users[0].id}
      `;
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe("magic_link");
    });

    test("does not sign the user in before they click the link", async () => {
      const request = await post({ email: "notyet@example.com" });
      await signup.create(request);

      expect(findSetCookie(request, "session_id")).toBeUndefined();
    });

    test("rejects an invalid email", async () => {
      const request = await post({ email: "nope" });
      await signup.create(request);

      expect(findSetCookie(request, "flash_state")).toContain(
        "Invalid email address",
      );
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });
  });

  describe("CSRF", () => {
    test("GET renders a token field and sets the guest session cookie", async () => {
      const request = get();
      const html = await (await signup.index(request)).text();

      expect(html).toContain('name="_csrf"');
      expect(findSetCookie(request, "session_id")).toBeDefined();
    });

    test("refuses a post with no token, creating nothing", async () => {
      const response = await signup.create(
        await post({ email: "notoken@example.com" }, { csrf: false }),
      );

      expect(response.status).toBe(403);
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });

    test("refuses a forged token", async () => {
      const response = await signup.create(
        await post(
          { email: "forged@example.com" },
          { csrf: "nonce.notarealtoken" },
        ),
      );

      expect(response.status).toBe(403);
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });

    test("refuses a post from another origin", async () => {
      const response = await signup.create(
        await post(
          { email: "crossorigin@example.com" },
          { origin: "https://evil.example" },
        ),
      );

      expect(response.status).toBe(403);
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });

    test("recovers from a stale but authentic token", async () => {
      const sessionId = await createGuestSession();
      const request = await post(
        { email: "staletab@example.com" },
        { sessionId, csrf: await staleCsrfToken(sessionId, "/signup") },
      );

      const response = await signup.create(request);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/signup");
      expect(findSetCookie(request, "flash_state")).toContain(
        "validation-error",
      );
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });
  });

  describe("bot defense", () => {
    test("feigns success and creates nothing when the honeypot is filled", async () => {
      const request = await post({
        email: "bot@example.com",
        [HONEYPOT_FIELD]: "http://spam.example",
      });

      const response = await signup.create(request);

      expect(response.status).toBe(303);
      expect(findSetCookie(request, "flash_state")).toContain("email-sent");
      expect(await db`SELECT id FROM cms_users`).toHaveLength(0);
    });

    test("returns 429 once the per-IP rate limit is exceeded", async () => {
      for (let i = 0; i < 5; i++) {
        await signup.create(await post({ email: "flood@example.com" }));
      }

      expect(
        (await signup.create(await post({ email: "flood@example.com" })))
          .status,
      ).toBe(429);
    });
  });

  describe("the console link hint", () => {
    const ORIGINAL_PROVIDER = process.env.EMAIL_PROVIDER;

    afterAll(() => {
      if (ORIGINAL_PROVIDER === undefined) delete process.env.EMAIL_PROVIDER;
      else process.env.EMAIL_PROVIDER = ORIGINAL_PROVIDER;
    });

    const sentPage = async () => {
      const request = get();
      stateHelpers<SignupState>().setFlash(request, { state: "email-sent" });

      return (await signup.index(request)).text();
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
});
