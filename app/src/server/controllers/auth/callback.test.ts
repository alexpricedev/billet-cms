import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BunRequest } from "bun";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { createMagicLink } from "../../services/auth";
import { db } from "../../services/database";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { callback } from "./callback";

const ORIGIN = process.env.APP_URL as string;

/**
 * Seed the site identity, then mint its magic link.
 *
 * Sign-in is invite-only: `createMagicLink` returns null for an address
 * `cms_identities` does not expose, so the callback tests seed the site user
 * first.
 */
const magicLinkFor = async (email: string) => {
  await seedIdentity(db, email);
  const link = await createMagicLink(email);
  if (!link) throw new Error(`no identity for ${email}`);
  return link;
};

const cookieValue = (req: BunRequest, name: string): string => {
  const match = findSetCookie(req, name)?.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`no ${name} cookie was set`);
  return match[1];
};

/** The confirm page the link lands on, plus what it hands the browser. */
const openLink = async (rawToken?: string) => {
  const req = createBunRequest(
    `${ORIGIN}/auth/callback${rawToken ? `?token=${rawToken}` : ""}`,
    { method: "GET" },
  );
  const res = await callback.index(req);
  const html = res.status === 200 ? await res.text() : "";

  return {
    req,
    res,
    html,
    csrfToken: html.match(/name="_csrf" value="([^"]+)"/)?.[1],
  };
};

/** Submitting that page's form — the step that spends the token. */
const submitConfirm = async (opts: {
  token: string;
  csrfToken?: string;
  sessionId?: string;
  origin?: string;
}) => {
  const req = createBunRequest(`${ORIGIN}/auth/callback`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: opts.origin ?? ORIGIN,
      ...(opts.sessionId ? { cookie: `cms_session=${opts.sessionId}` } : {}),
    },
    body: new URLSearchParams({
      _csrf: opts.csrfToken ?? "",
      token: opts.token,
    }).toString(),
  });

  return { req, res: await callback.create(req) };
};

/** The whole journey: open the link, then click the button. */
const signIn = async (rawToken: string) => {
  const opened = await openLink(rawToken);
  const submitted = await submitConfirm({
    token: rawToken,
    csrfToken: opened.csrfToken,
    sessionId: cookieValue(opened.req, "cms_session"),
  });

  return { ...submitted, opened };
};

const errorFrom = (res: Response): string =>
  decodeURIComponent(res.headers.get("location") ?? "");

describe("Callback Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("GET /auth/callback", () => {
    // The reason this page exists: mail filters fetch every link they deliver,
    // and a fetch that spent the token would leave the recipient clicking a
    // link that was already dead. A GET must not touch it.
    test("does not spend the token", async () => {
      const { user, rawToken } = await magicLinkFor("scanned@example.com");

      const { res, html } = await openLink(rawToken);

      expect(res.status).toBe(200);
      expect(html).toContain("Confirm sign in");

      const tokens = await db`
        SELECT used_at FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;
      expect(tokens[0].used_at).toBeNull();
    });

    test("still signs in after a scanner has fetched the link twice", async () => {
      const { rawToken } = await magicLinkFor("prefetched@example.com");

      await openLink(rawToken);
      await openLink(rawToken);

      const { res } = await signIn(rawToken);

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    });

    test("carries the token and a CSRF field into the form", async () => {
      const { rawToken } = await magicLinkFor("form@example.com");

      const { html, csrfToken } = await openLink(rawToken);

      expect(html).toContain(`name="token" value="${rawToken}"`);
      expect(csrfToken).toBeTruthy();
    });

    // The page holds a live sign-in token, and a cached copy would re-present a
    // form whose token has since been spent.
    test("is never cached", async () => {
      const { rawToken } = await magicLinkFor("nocache@example.com");

      const { res } = await openLink(rawToken);

      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    // Renders the same page for a token that was never real: checking here
    // would either spend it or sort guesses from the genuine article.
    test("renders the form for an unknown token without judging it", async () => {
      const { res, html } = await openLink("not-a-real-token");

      expect(res.status).toBe(200);
      expect(html).toContain("Confirm sign in");
    });

    test("redirects with error for missing token", async () => {
      const { res } = await openLink();

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "/login?error=Missing authentication token",
      );
    });
  });

  describe("POST /auth/callback", () => {
    test("successfully verifies valid magic link token", async () => {
      const { rawToken } = await magicLinkFor("test@example.com");

      const { req, res } = await signIn(rawToken);

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");

      const setCookie = findSetCookie(req, "cms_session");
      expect(setCookie).toContain("cms_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
    });

    test("marks token as used after successful verification", async () => {
      const { user, rawToken } = await magicLinkFor("used@example.com");

      await signIn(rawToken);

      const tokens = await db`
        SELECT used_at FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      expect(tokens).toHaveLength(1);
      expect(tokens[0].used_at).not.toBeNull();
    });

    test("creates valid session after token verification", async () => {
      const { user, rawToken } = await magicLinkFor("session@example.com");

      const { req } = await signIn(rawToken);
      const sessionId = cookieValue(req, "cms_session");

      const { computeHMAC } = await import("../../utils/crypto");
      const sessions = await db`
        SELECT user_id, expires_at FROM cms_sessions
        WHERE id_hash = ${computeHMAC(sessionId)}
      `;

      expect(sessions).toHaveLength(1);
      expect(sessions[0].user_id).toBe(user.id);

      const expiresAt = new Date(sessions[0].expires_at as string);
      const diffDays =
        (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThan(31);
    });

    // A cross-site auto-submit here would be login CSRF: a visitor dropped into
    // a session, and an account, they never asked for.
    test("rejects a submission with no CSRF token", async () => {
      const { rawToken } = await magicLinkFor("nocsrf@example.com");
      const opened = await openLink(rawToken);

      const { res } = await submitConfirm({
        token: rawToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(403);
    });

    test("rejects a submission from another origin", async () => {
      const { rawToken } = await magicLinkFor("crossorigin@example.com");
      const opened = await openLink(rawToken);

      const { res } = await submitConfirm({
        token: rawToken,
        csrfToken: opened.csrfToken,
        sessionId: cookieValue(opened.req, "cms_session"),
        origin: "https://evil.example",
      });

      expect(res.status).toBe(403);
    });

    test("leaves the token unspent when the CSRF check fails", async () => {
      const { user, rawToken } = await magicLinkFor("survives@example.com");
      const opened = await openLink(rawToken);

      await submitConfirm({
        token: rawToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      const tokens = await db`
        SELECT used_at FROM cms_user_tokens
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;
      expect(tokens[0].used_at).toBeNull();
    });

    test("redirects with error for missing token", async () => {
      const { rawToken } = await magicLinkFor("blank@example.com");
      const opened = await openLink(rawToken);

      const { res } = await submitConfirm({
        token: "",
        csrfToken: opened.csrfToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "/login?error=Missing authentication token",
      );
    });

    test("redirects with error for invalid token", async () => {
      const opened = await openLink("invalid-token");

      const { res } = await submitConfirm({
        token: "invalid-token",
        csrfToken: opened.csrfToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(303);
      expect(errorFrom(res)).toContain("Invalid or expired token");
    });

    test("redirects with error for already used token", async () => {
      const { rawToken } = await magicLinkFor("reuse@example.com");

      await signIn(rawToken);
      const { res } = await signIn(rawToken);

      expect(res.status).toBe(303);
      expect(errorFrom(res)).toContain("Invalid or expired token");
    });

    test("redirects with error for expired token", async () => {
      const { user, rawToken } = await magicLinkFor("expired@example.com");
      const opened = await openLink(rawToken);

      await db`
        UPDATE cms_user_tokens
        SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE user_id = ${user.id} AND type = 'magic_link'
      `;

      const { res } = await submitConfirm({
        token: rawToken,
        csrfToken: opened.csrfToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(303);
      expect(errorFrom(res)).toContain("expired");
    });

    test("handles database errors gracefully", async () => {
      const { user, rawToken } = await magicLinkFor("deleted@example.com");
      const opened = await openLink(rawToken);
      const sessionId = cookieValue(opened.req, "cms_session");

      await db`DELETE FROM users WHERE id = ${user.id}`;

      const { res } = await submitConfirm({
        token: rawToken,
        csrfToken: opened.csrfToken,
        sessionId,
      });

      expect(res.status).toBe(303);
      expect(errorFrom(res)).toContain("User not found");
    });
  });
});

// Sign-in always lands on "/". The team redirect that used to live here went
// with the team feature; the CMS has no /team page to discover.
