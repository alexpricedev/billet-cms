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
    expect(res.headers.get("location")).toBe("/sign-in");
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

  // An unlabelled slot shows its name as the link; repeating it in the muted
  // <code> beside it says the same thing twice.
  test("shows an unlabelled slot's name once, not twice", async () => {
    await seedBlockType(db, hero);
    await seedSlot(db, {
      name: "about.intro",
      blockName: "hero",
      page: "about",
    });

    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();

    expect(html.match(/about\.intro/g) ?? []).toHaveLength(1);
  });

  const seedRevision = async (
    slotId: string,
    createdAt: string,
  ): Promise<string> => {
    const rows = (await db`
      INSERT INTO cms_revisions (id, target_type, target_id, content, created_at)
      VALUES (gen_random_uuid(), 'slot', ${slotId}, '{}'::jsonb, ${createdAt})
      RETURNING id
    `) as { id: string }[];
    return rows[0].id;
  };

  test("says whether each slot is live, a draft or never published", async () => {
    await seedBlockType(db, hero);
    const liveId = await seedSlot(db, {
      name: "a.live",
      blockName: "hero",
      page: "a",
    });
    const draftId = await seedSlot(db, {
      name: "a.draft",
      blockName: "hero",
      page: "a",
    });
    const neverId = await seedSlot(db, {
      name: "a.never",
      blockName: "hero",
      page: "a",
    });

    const liveRev = await seedRevision(liveId, "2026-01-10T09:00:00Z");
    const published = await seedRevision(draftId, "2026-01-10T09:00:00Z");
    await seedRevision(draftId, "2026-01-12T09:00:00Z");
    await seedRevision(neverId, "2026-01-11T09:00:00Z");
    await db`UPDATE cms_slots SET published_revision_id = ${liveRev} WHERE id = ${liveId}`;
    await db`UPDATE cms_slots SET published_revision_id = ${published} WHERE id = ${draftId}`;

    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();

    expect(html).toContain("cms-slot-state-live");
    expect(html).toContain("Draft since 12 Jan 2026");
    expect(html).toContain("Never published");
  });
});
