import { describe, expect, test } from "bun:test";
import { createBunRequest } from "../../test-utils/bun-request";
import { landing } from "./landing";

describe("Landing Controller", () => {
  test("redirects the bare origin to the CMS surface", () => {
    const res = landing.index(createBunRequest("http://localhost:3000/"));

    // A temporary redirect, not a permanent one: `/cms` is guarded, so the
    // browser has to come back here through `/sign-in` rather than caching the
    // hop to the dashboard.
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/cms");
  });
});
