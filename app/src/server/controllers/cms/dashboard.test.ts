import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, pageType, text } from "@alexpricedev/billet-cms/fields";
import {
  seedBlockType,
  seedPageType,
  seedSlot,
} from "../../test-utils/content";
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
    expect(html).toContain("<h2>Home</h2>");
    expect(html).toContain("<h2>About</h2>");
    expect(html).toContain("Home hero");
    expect(html).not.toContain("home.hero");
    expect(html).not.toContain("cms-slot-block");
    expect(html).not.toContain(">hero<");
  });

  test("introduces the list in the editor's words", async () => {
    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();
    const intro = html.match(/<p class="cms-intro">([\s\S]*?)<\/p>/)?.[1];

    expect(intro).toContain("parts of the site you can edit");
    expect(intro).toContain("drafts");
    expect(intro).not.toMatch(/slot|template|deploy/i);
    for (const label of ["Pages", "Media", "Export"]) {
      expect(html).toContain(`>${label}</a>`);
    }
  });

  // The empty dashboard is a state, not a result: the banner names what is
  // missing and closing it would leave the page blank until a reload brought
  // it back. No ×.
  test("the empty dashboard has no dismiss button", async () => {
    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();

    expect(html).toContain("No slots are published yet.");
    expect(html).not.toContain("data-flash-dismiss");
  });

  test("explains the page types and points at Pages", async () => {
    await seedBlockType(db, hero);
    await seedPageType(
      db,
      pageType("landing", { allowedBlocks: [hero], requiredBlocks: [hero] }),
    );

    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();
    const section = html.slice(html.indexOf("<h2>Page types</h2>"));

    expect(section).toContain("starts as one of these");
    expect(section).toContain('href="/cms/pages"');
    expect(section).toContain("Landing");
    expect(section).not.toContain("<code>");
  });

  // The developer's key stays out of the list; an unlabelled slot reads as
  // its key in words.
  test("shows an unlabelled slot in words, not as its key", async () => {
    await seedBlockType(db, hero);
    await seedSlot(db, {
      name: "about.intro",
      blockName: "hero",
      page: "about",
    });

    const identity = await seedIdentity(db, "editor@example.com");
    const session = await createAuthenticatedSession(identity.id);

    const html = await (await dashboard.index(get(session))).text();

    expect(html).not.toContain("about.intro");
    expect(html.match(/About intro/g) ?? []).toHaveLength(1);
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
