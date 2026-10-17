import { describe, expect, test } from "bun:test";
import { createBunRequest } from "../../test-utils/bun-request";
import { landing } from "./landing";

describe("Landing Controller", () => {
  test("redirects the bare origin to the CMS surface", () => {
    const res = landing.index(createBunRequest("http://localhost:3000/"));

    // A temporary redirect, not a permanent one: a cached 301 would be hard to
    // undo, and the root should stay free to change. (`/cms` guards itself, so
    // caching the hop could not skip the check.)
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/cms");
  });
});
