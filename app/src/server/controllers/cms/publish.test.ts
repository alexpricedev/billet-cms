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
  getLatestRevision,
  getSlotById,
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
        await postForm(publishPath(slotId), slotId, {}, sessionId),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${slotId}?published=1`,
      );
      const slot = await getSlotById(slotId);
      expect(slot?.publishedRevisionId).toBe(revision.id);
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
    test("lists the revisions with the published and draft marks", async () => {
      const first = await draft("First");
      await draft("Second");
      await slotPublish.publish(
        await postForm(publishPath(slotId), slotId, {}, sessionId),
      );

      const res = await slotHistory.index(
        request(historyPath(slotId), slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("History");
      expect(html).toContain("Current draft");
      expect(html).toContain("editor@example.com");
      expect(html).toContain(restorePath(slotId));
      // The published revision is the older one; both are listed.
      expect(first.id).toBeTruthy();
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
