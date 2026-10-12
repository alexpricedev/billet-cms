import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { CMS_SIGN_IN_PATH } from "../contract";
import { handleCmsSignIn } from "./index";

const CMS_URL = "https://cms.example.com";

/**
 * A stand-in pool. The two paths under test are the identity check (a SELECT
 * against `cms_identities`) and the handoff-token insert; both go through
 * `unsafe`, so the fake dispatches on the query text and records what it saw.
 */
const fakeSql = (options: { identity: boolean } = { identity: true }) => {
  const inserts: unknown[][] = [];
  const sql = {
    unsafe: async (query: string, params?: unknown[]) => {
      if (query.includes("cms_identities")) {
        return options.identity ? [{ "?column?": 1 }] : [];
      }
      if (query.includes("INSERT INTO")) inserts.push(params ?? []);
      return [];
    },
  } as unknown as SQL;
  return { sql, inserts };
};

const request = (url: string): Request => new Request(url);

describe("handleCmsSignIn", () => {
  test("sends a signed-out visitor through the site's login and back", async () => {
    const { sql } = fakeSql();
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in?from=cms"),
      { sql, cmsUrl: CMS_URL, getUserId: () => null },
    );

    expect(res.status).toBe(303);
    const location = res.headers.get("location") as string;
    expect(location).toBe(
      `/login?next=${encodeURIComponent("/cms/sign-in?from=cms")}`,
    );
    // The origin is never carried into `next`, so the return can't leave the site.
    expect(location).not.toContain("https://");
  });

  test("mints a handoff token and redirects into the CMS when signed in", async () => {
    const { sql, inserts } = fakeSql({ identity: true });
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in"),
      {
        sql,
        cmsUrl: CMS_URL,
        getUserId: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect(res.status).toBe(303);
    const location = res.headers.get("location") as string;
    expect(location.startsWith(`${CMS_URL}/handoff?token=`)).toBe(true);

    // The token was written, and only its hash reaches the database.
    expect(inserts).toHaveLength(1);
    const [userId, tokenHash, expiresAt] = inserts[0] as [string, string, Date];
    expect(userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(
      new URL(location).searchParams.get("token") as string,
    );
    // Short-lived, as the shared handoff mechanism guarantees.
    const seconds = (new Date(expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThan(70);
  });

  test("refuses a signed-in site user who is not a CMS identity, writing no token", async () => {
    const { sql, inserts } = fakeSql({ identity: false });
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in"),
      {
        sql,
        cmsUrl: CMS_URL,
        getUserId: () => "22222222-2222-4222-8222-222222222222",
      },
    );

    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  test("treats a failing user lookup as signed out rather than crashing", async () => {
    const { sql } = fakeSql();
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in"),
      {
        sql,
        cmsUrl: CMS_URL,
        getUserId: () => {
          throw new Error("no session store");
        },
      },
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  test("answers 503 when the CMS URL is not configured", async () => {
    const { sql, inserts } = fakeSql({ identity: true });
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in"),
      {
        sql,
        cmsUrl: "",
        getUserId: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect(res.status).toBe(503);
    expect(inserts).toHaveLength(0);
  });

  test("defaults the mounted path to the shared contract constant", async () => {
    const { sql } = fakeSql();
    const res = await handleCmsSignIn(
      request("https://site.example.com/cms/sign-in"),
      {
        sql,
        getUserId: () => null,
      },
    );

    expect(CMS_SIGN_IN_PATH).toBe("/cms/sign-in");
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent(CMS_SIGN_IN_PATH)}`,
    );
  });
});
