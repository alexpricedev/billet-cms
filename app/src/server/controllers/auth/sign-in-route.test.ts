import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { createBunRequest } from "../../test-utils/bun-request";
import { signIn } from "./sign-in";

describe("CMS /sign-in route", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("sends a signed-out visitor to the site's sign-in route", async () => {
    const res = await signIn.index(
      createBunRequest("http://localhost:3000/sign-in"),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `${process.env.SITE_APP_URL}/cms/sign-in`,
    );
  });

  test("sends an already signed-in visitor to the content", async () => {
    const user = await seedIdentity(db, "signed-in@example.com");
    const sessionId = await createAuthenticatedSession(user.id);

    const res = await signIn.index(
      createBunRequest("http://localhost:3000/sign-in", {
        headers: { cookie: `cms_session=${sessionId}` },
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cms");
  });

  test("answers a clear 503 when the site URL is not configured", async () => {
    const previous = process.env.SITE_APP_URL;
    delete process.env.SITE_APP_URL;
    try {
      const res = await signIn.index(
        createBunRequest("http://localhost:3000/sign-in"),
      );

      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Sign-in is unavailable");
    } finally {
      if (previous !== undefined) process.env.SITE_APP_URL = previous;
    }
  });
});
