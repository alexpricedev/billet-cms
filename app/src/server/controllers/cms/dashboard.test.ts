import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, text } from "@alexpricedev/billet-cms/fields";
import { seedBlockType, seedSlot } from "../../test-utils/content";
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
import { dashboard } from "./dashboard";

const ORIGIN = process.env.APP_URL as string;

const hero = block("hero", { heading: text() }, () => null);

describe("Dashboard controller", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const get = (session: string) =>
    createBunRequest(`${ORIGIN}/cms`, {
      method: "GET",
      headers: { cookie: `cms_session=${session}` },
    });

  test("redirects an anonymous visitor to sign in", async () => {
    const res = await dashboard.index(
      createBunRequest(`${ORIGIN}/cms`, { method: "GET" }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("lists the pages and the slots published into them", async () => {
    await seedBlockType(db, hero);
    await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
      label: "Home hero",
    });
    await seedSlot(db, {
      name: "about.intro",
      blockName: "hero",
      page: "about",
    });

    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();

    expect(html).toContain("Content");
    expect(html).toContain("home");
    expect(html).toContain("about");
    expect(html).toContain("Home hero");
    expect(html).toContain("home.hero");
  });
});
