import { describe, expect, mock, test } from "bun:test";

// `./app` pulls in the controllers, which reach the database module as they are
// imported. The route table is static, so stub the pool rather than open one.
mock.module("../services/database", () => ({
  db: {},
  closeDatabase: async () => {},
}));

import { handleFallback } from "../utils/fallback";
import { appRoutes } from "./app";

describe("app routes", () => {
  // Invite-only sign-in: /signup was removed, and nothing should put it back
  // without a deliberate decision.
  test("does not declare a /signup route", () => {
    expect(appRoutes).not.toHaveProperty("/signup");
  });

  // The CMS has no sign-in of its own (review round 4): the magic-link login and
  // its callback are gone, and /sign-in hands off to the site.
  test("has no CMS login route, and a /sign-in handoff instead", () => {
    expect(appRoutes).not.toHaveProperty("/login");
    expect(appRoutes).not.toHaveProperty("/auth/callback");
    expect(appRoutes).toHaveProperty("/sign-in");
  });

  test("/signup falls through to the 404 page", async () => {
    // The route table above is what actually decides this: the fallback is only
    // reached for a path no declared route claimed.
    const response = await handleFallback(
      new Request("http://localhost:3000/signup"),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
  });
});
