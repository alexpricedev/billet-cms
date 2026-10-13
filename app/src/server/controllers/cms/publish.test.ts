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

import {
  createRevision,
  getLatestRevision,
  getSlotById,
  publishSlot,
  saveSlotDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { createBunRequest } from "../../test-utils/bun-request";
import { slotHistory } from "./history";
import { slotPublish } from "./publish";

const ORIGIN = process.env.APP_URL as string;

const hero = block("hero", { heading: text({ max: 80 }) }, () => null);
const content = (heading: string) => ({ heading });

const publishPath = (id: string) => `/cms/slots/${id}/publish`;
const restorePath = (id: string) => `/cms/slots/${id}/restore`;
const historyPath = (id: string) => `/cms/slots/${id}/history`;

const request = (
  path: string,
  slotId: string,
  init: RequestInit,
): ReturnType<typeof createBunRequest> =>
  createBunRequest(`${ORIGIN}${path}`, init, { id: slotId });

const postForm = async (
  path: string,
  slotId: string,
  fields: Record<string, string>,
  sessionId: string,
  csrf?: string,
) => {
  const formData = new FormData();
  formData.append(
    "_csrf",
    csrf ?? (await createCsrfToken(sessionId, "POST", path)),
  );
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return request(path, slotId, {
    method: "POST",
    headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
    body: formData,
  });
};

describe("slot publish and history controllers", () => {
  let slotId: string;
  let editorId: string;
  let sessionId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, hero);
    slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
      label: "Home hero",
    });
    editorId = (await seedIdentity(db, "editor@example.com")).id;
    sessionId = await createAuthenticatedSession(editorId);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const draft = async (heading: string) => {
    const result = await saveSlotDraft({
      slotId,
      content: content(heading),
      baseRevisionId: (await getLatestRevision("slot", slotId))?.id ?? null,
      actorId: editorId,
    });
    if (!result.ok) throw new Error("draft failed");
    return result.revision;
  };

  describe("publish", () => {
    test("redirects an anonymous visitor to sign in", async () => {
      const res = await slotPublish.publish(
        request(publishPath(slotId), slotId, { method: "POST" }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
    });

    test("rejects a CSRF token minted for another path", async () => {
      const res = await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          {},
          sessionId,
          await createCsrfToken(sessionId, "POST", historyPath(slotId)),
        ),
      );

      expect(res.status).toBe(403);
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBeNull();
    });

    test("publishes the newest draft", async () => {
      const revision = await draft("Live");

      const res = await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          { revision: revision.id },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?published=1`,
      );
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBe(revision.id);
    });

    // The form posts the revision it rendered. If a colleague saved after that,
    // publishing now would put work the editor never saw live, so it stops.
    test("warns instead of publishing a newer draft than the one shown", async () => {
      const first = await draft("First");
      await draft("Second");

      const res = await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          { revision: first.id },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?publish=stale`,
      );
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBeNull();
    });

    // A malformed id used to reach the UUID column through the stale check and
    // 500; it now reads as a form that no longer names a live revision.
    test("treats a revision id that is not a UUID as stale", async () => {
      await draft("Live");

      const res = await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          { revision: "not-a-uuid" },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?publish=stale`,
      );
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBeNull();
    });

    test("says so when there is no draft to publish", async () => {
      const res = await slotPublish.publish(
        await postForm(publishPath(slotId), slotId, {}, sessionId),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?publish=empty`,
      );
    });

    test("refuses a draft that no longer validates", async () => {
      // Written directly so the save layer's validation doesn't reject it: a
      // deploy can change a block under a draft that was saved when it passed.
      const invalid = await createRevision({
        targetType: "slot",
        targetId: slotId,
        content: { heading: 7 },
        createdBy: editorId,
      });

      const res = await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          { revision: invalid.id },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?publish=invalid`,
      );
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBeNull();
    });

    test("says so when the block type was removed", async () => {
      await draft("Live");
      await db`UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'`;

      const res = await slotPublish.publish(
        await postForm(publishPath(slotId), slotId, {}, sessionId),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?unavailable=1`,
      );
    });
  });

  describe("restore", () => {
    test("redirects an anonymous visitor to sign in", async () => {
      const res = await slotPublish.restore(
        request(restorePath(slotId), slotId, { method: "POST" }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
    });

    test("rejects a CSRF token minted for another path", async () => {
      const first = await draft("First");
      const res = await slotPublish.restore(
        await postForm(
          restorePath(slotId),
          slotId,
          { revision: first.id },
          sessionId,
          await createCsrfToken(sessionId, "POST", publishPath(slotId)),
        ),
      );

      expect(res.status).toBe(403);
      // Nothing copied: the only revision is the one the draft made.
      const rows = (await db`SELECT id FROM cms_revisions`) as { id: string }[];
      expect(rows).toHaveLength(1);
    });

    test("copies an old revision into a new draft", async () => {
      const first = await draft("First");
      await draft("Second");

      const res = await slotPublish.restore(
        await postForm(
          restorePath(slotId),
          slotId,
          { revision: first.id },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?restored=1`,
      );
      expect((await getLatestRevision("slot", slotId))?.content.heading).toBe(
        "First",
      );
    });

    // A malformed id used to reach the UUID column and 500; it now reads as a
    // revision that isn't available.
    test("handles a revision id that is not a UUID", async () => {
      const res = await slotPublish.restore(
        await postForm(
          restorePath(slotId),
          slotId,
          { revision: "not-a-uuid" },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${historyPath(slotId)}?error=not-found`,
      );
    });

    test("reports a revision that is no longer available", async () => {
      const res = await slotPublish.restore(
        await postForm(
          restorePath(slotId),
          slotId,
          { revision: "00000000-0000-4000-8000-000000000000" },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${historyPath(slotId)}?error=not-found`,
      );
    });
  });

  describe("history", () => {
    // Each row of the history list, newest first. The list is flat, so a split
    // on the item class gives one entry per revision.
    const historyRows = (html: string): string[] =>
      html.split('<li class="cms-history-item"').slice(1);

    test("marks the published revision and the current draft on the right rows", async () => {
      const first = await draft("First");
      const second = await draft("Second");
      // Publish the older draft so the badges land on different rows: `second`
      // is the newest (draft), `first` is what the site renders.
      await publishSlot({ slotId, revisionId: first.id });

      const res = await slotHistory.index(
        request(historyPath(slotId), slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("History");
      expect(html).toContain("editor@example.com");

      const rows = historyRows(html);
      expect(rows).toHaveLength(2);

      const [newest, older] = rows;
      // The newest revision is the current draft and is not the published one.
      expect(newest).toContain("Current draft");
      expect(newest).not.toContain("cms-history-published");
      // The older revision is published and offers a restore, naming its id.
      expect(older).toContain("cms-history-published");
      expect(older).toContain("Published");
      expect(older).not.toContain("Current draft");
      expect(older).toContain(`value="${first.id}"`);
      expect(second.id).toBeTruthy();
    });

    test("shows a neutral empty state before anything is saved", async () => {
      const res = await slotHistory.index(
        request(historyPath(slotId), slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("no saved revisions yet");
      expect(html).toContain("cms-history-empty");
      expect(html).not.toContain("flash-warning");
    });

    test("redirects an anonymous visitor to sign in", async () => {
      const res = await slotHistory.index(
        request(historyPath(slotId), slotId, { method: "GET" }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
    });

    test("renders a 404 for a slot that does not exist", async () => {
      const missing = "00000000-0000-4000-8000-000000000000";
      const res = await slotHistory.index(
        request(historyPath(missing), missing, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});
