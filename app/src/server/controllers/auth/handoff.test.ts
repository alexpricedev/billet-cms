import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createEditContentLink } from "@alexpricedev/billet-cms/handoff";
import type { BunRequest } from "bun";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { createBunRequest, findSetCookie } from "../../test-utils/bun-request";
import { handoff } from "./handoff";

const ORIGIN = process.env.APP_URL as string;

const cookieValue = (req: BunRequest, name: string): string => {
  const match = findSetCookie(req, name)?.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`no ${name} cookie was set`);
  return match[1];
};

const mintTokenFor = async (email: string): Promise<string> => {
  const identity = await seedIdentity(db, email);
  const link = await createEditContentLink(db, {
    userId: identity.id,
    cmsUrl: "https://cms.example.com",
  });
  if (!link) throw new Error("no link minted");
  const token = new URL(link).searchParams.get("token");
  if (!token) throw new Error("no token in link");
  return token;
};

const open = async (token?: string) => {
  const req = createBunRequest(
    `${ORIGIN}/handoff${token ? `?token=${token}` : ""}`,
    { method: "GET" },
  );
  const res = await handoff.index(req);
  const html = res.status === 200 ? await res.text() : "";
  return {
    req,
    res,
    html,
    csrfToken: html.match(/name="_csrf" value="([^"]+)"/)?.[1],
  };
};

const submit = async (opts: {
  token: string;
  csrfToken?: string;
  sessionId?: string;
}) => {
  const req = createBunRequest(`${ORIGIN}/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      ...(opts.sessionId ? { cookie: `cms_session=${opts.sessionId}` } : {}),
    },
    body: new URLSearchParams({
      _csrf: opts.csrfToken ?? "",
      token: opts.token,
    }).toString(),
  });
  return { req, res: await handoff.create(req) };
};

const errorFrom = (res: Response): string =>
  decodeURIComponent(res.headers.get("location") ?? "");

describe("Handoff Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("GET /handoff", () => {
    test("renders a confirm step without spending the token", async () => {
      const token = await mintTokenFor("admin@example.com");

      const { res, html } = await open(token);

      expect(res.status).toBe(200);
      expect(html).toContain("Edit content");
      expect(html).toContain(`name="token" value="${token}"`);

      const rows = await db`SELECT used_at FROM cms_handoff_tokens`;
      expect(rows[0].used_at).toBeNull();
    });

    test("redirects with an error when no token is given", async () => {
      const { res } = await open();

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "/login?error=Missing handoff token",
      );
    });

    test("sends an already signed-in visitor to the content", async () => {
      const identity = await seedIdentity(db, "signed-in@example.com");
      const sessionId = await createAuthenticatedSession(identity.id);
      const token = await mintTokenFor("other@example.com");

      const req = createBunRequest(`${ORIGIN}/handoff?token=${token}`, {
        method: "GET",
        headers: { cookie: `cms_session=${sessionId}` },
      });
      const res = await handoff.index(req);

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/cms");
    });
  });

  describe("POST /handoff", () => {
    test("spends the token and signs the admin in", async () => {
      const token = await mintTokenFor("admin@example.com");
      const opened = await open(token);

      const { req, res } = await submit({
        token,
        csrfToken: opened.csrfToken,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/cms");

      const setCookie = findSetCookie(req, "cms_session");
      expect(setCookie).toContain("cms_session=");
      expect(setCookie).toContain("HttpOnly");

      const sessions = await db`
        SELECT user_id FROM cms_sessions WHERE session_type = 'authenticated'
      `;
      expect(sessions).toHaveLength(1);
    });

    test("is single use — a second click signs nobody in", async () => {
      const token = await mintTokenFor("admin@example.com");

      const firstOpen = await open(token);
      await submit({
        token,
        csrfToken: firstOpen.csrfToken,
        sessionId: cookieValue(firstOpen.req, "cms_session"),
      });

      // A second click opens the page again, with its own fresh guest session.
      const secondOpen = await open(token);
      const second = await submit({
        token,
        csrfToken: secondOpen.csrfToken,
        sessionId: cookieValue(secondOpen.req, "cms_session"),
      });

      expect(second.res.status).toBe(303);
      expect(errorFrom(second.res)).toContain("Invalid or expired link");
    });

    test("refuses a submission with no CSRF token, leaving the token unspent", async () => {
      const token = await mintTokenFor("admin@example.com");
      const opened = await open(token);

      const { res } = await submit({
        token,
        sessionId: cookieValue(opened.req, "cms_session"),
      });

      expect(res.status).toBe(403);
      const rows = await db`SELECT used_at FROM cms_handoff_tokens`;
      expect(rows[0].used_at).toBeNull();
    });
  });
});
