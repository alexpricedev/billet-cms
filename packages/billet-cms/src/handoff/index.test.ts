import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  createEditContentLink,
  HANDOFF_TOKEN_TTL_SECONDS,
  hashHandoffToken,
} from "./index";

// A stand-in for the pool: the paths under test here never reach it. The
// database behaviour lives in the CMS app's tests, where a connection exists.
const unusedSql = (() => {
  throw new Error("the database must not be touched on this path");
}) as unknown as SQL;

describe("hashHandoffToken", () => {
  test("is a stable SHA-256 hex", () => {
    expect(hashHandoffToken("abc")).toBe(hashHandoffToken("abc"));
    expect(hashHandoffToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHandoffToken("abc")).not.toBe(hashHandoffToken("abd"));
  });
});

describe("HANDOFF_TOKEN_TTL_SECONDS", () => {
  test("is the 60-second window the spec asks for", () => {
    expect(HANDOFF_TOKEN_TTL_SECONDS).toBe(60);
  });
});

describe("createEditContentLink", () => {
  test("returns null, and never touches the database, when no CMS URL is set (Q8)", async () => {
    const previous = process.env.CMS_URL;
    delete process.env.CMS_URL;
    try {
      const link = await createEditContentLink(unusedSql, {
        userId: "00000000-0000-4000-8000-000000000000",
        cmsUrl: "",
      });
      expect(link).toBeNull();
    } finally {
      if (previous !== undefined) process.env.CMS_URL = previous;
    }
  });

  test("checks the identity inside the insert, in one query", async () => {
    const calls: { query: string; params: unknown[] }[] = [];
    const sqlFor = (identity: boolean) =>
      ({
        unsafe: async (query: string, params: unknown[] = []) => {
          calls.push({ query, params });
          // The real `WHERE EXISTS` writes a row for an identity and none
          // otherwise.
          return identity ? [{ id: "handoff-token" }] : [];
        },
      }) as unknown as SQL;

    const userId = "11111111-1111-4111-8111-111111111111";
    const link = await createEditContentLink(sqlFor(true), {
      userId,
      cmsUrl: "https://cms.example.com",
    });

    expect(link).toStartWith("https://cms.example.com/handoff?token=");
    // One round trip, and the identity check is the insert's own guard — no
    // separate SELECT that could disagree with it.
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("INSERT INTO");
    expect(calls[0].query).toContain("WHERE EXISTS");
    expect(calls[0].params[0]).toBe(userId);

    calls.length = 0;
    const hidden = await createEditContentLink(sqlFor(false), {
      userId,
      cmsUrl: "https://cms.example.com",
    });
    expect(hidden).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
