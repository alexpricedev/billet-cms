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

import { clearRateLimitLog } from "../../middleware/rate-limit";
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

describe("Handoff Controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
    // The auth budget is global (a Map keyed by bucket + address); clear it so
    // one case's posts don't spend another's.
    clearRateLimitLog();
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
      expect(html).toContain("Sign in to Billet CMS");
      expect(html).toContain("Continue to Billet CMS");
      expect(html).toContain(`name="token" value="${token}"`);
      // The footer link now comes from AuthPage's default rather than a prop
      // this template passes, so assert it still renders a way back into the
      // CMS.
      expect(html).toContain('href="/cms"');
      expect(html).toContain("Back to Billet CMS");

      const rows = await db`SELECT used_at FROM cms_handoff_tokens`;
      expect(rows[0].used_at).toBeNull();
    });

    test("redirects to sign-in when no token is given", async () => {
      const { res } = await open();

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
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
      expect(second.res.headers.get("location")).toBe("/sign-in");
    });

    // Two clicks arriving together must produce one session, not two: the
    // spend is a single conditional UPDATE, so only one can claim the row.
    test("spends the token once under concurrent clicks", async () => {
      const token = await mintTokenFor("admin@example.com");
      // Each click arrives with its own guest session, so the test isolates the
      // one shared thing — the token — rather than the sessions the winner
      // discards.
      const firstOpen = await open(token);
      const secondOpen = await open(token);

      const [first, second] = await Promise.all([
        submit({
          token,
          csrfToken: firstOpen.csrfToken,
          sessionId: cookieValue(firstOpen.req, "cms_session"),
        }),
        submit({
          token,
          csrfToken: secondOpen.csrfToken,
          sessionId: cookieValue(secondOpen.req, "cms_session"),
        }),
      ]);

      const locations = [first.res, second.res].map((res) =>
        res.headers.get("location"),
      );
      expect(locations.filter((location) => location === "/cms")).toHaveLength(
        1,
      );
      expect(
        locations.filter((location) => location === "/sign-in"),
      ).toHaveLength(1);

      const sessions = await db`
        SELECT user_id FROM cms_sessions WHERE session_type = 'authenticated'
      `;
      expect(sessions).toHaveLength(1);
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

    // /handoff is the one signed-out form POST the CMS renders, so it is the
    // route that spends the reserved `auth` budget. Ten posts fit (and are
    // refused at the CSRF step); the eleventh is stopped before any work.
    test("rate limits repeated submissions on the auth budget", async () => {
      const token = await mintTokenFor("admin@example.com");
      const opened = await open(token);
      const sessionId = cookieValue(opened.req, "cms_session");

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const { res } = await submit({ token, sessionId });
        expect(res.status).toBe(403);
      }

      const { res } = await submit({ token, sessionId });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
    });
  });
});
