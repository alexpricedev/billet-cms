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
});
