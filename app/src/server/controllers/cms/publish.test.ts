import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { block, image, text } from "@alexpricedev/billet-cms/fields";
import { createMemoryStorage } from "@alexpricedev/billet-storage";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { makeJpeg } from "../../test-utils/images";
import { jsonbValue } from "../../utils/sql";

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
  HISTORY_PAGE_SIZE,
  publishSlot,
  saveSlotDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createMedia } from "../../services/media";
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

    // Part 10: a narrow image is a site guideline, not a refusal. Publishing
    // goes ahead and the redirect says what is worth a second look.
    test("publishes a too-narrow image and says so", async () => {
      const narrow = block(
        "narrowHero",
        { photo: image({ minWidth: 1600 }) },
        () => null,
      );
      await seedBlockType(db, narrow);
      const narrowSlotId = await seedSlot(db, {
        name: "home.narrow",
        blockName: "narrowHero",
        page: "home",
      });
      const small = await createMedia({
        bytes: await makeJpeg(800, 400),
        alt: "Too small",
        actorId: null,
        storage: createMemoryStorage(),
      });
      if (!small.ok) throw new Error("upload failed");
      const saved = await saveSlotDraft({
        slotId: narrowSlotId,
        content: { photo: { mediaId: small.media.id } },
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");

      const res = await slotPublish.publish(
        await postForm(
          publishPath(narrowSlotId),
          narrowSlotId,
          { revision: saved.revision.id },
          sessionId,
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/cms/slots/${narrowSlotId}?published=1&warn=1`,
      );
      const slot = await getSlotById(narrowSlotId);
      expect(slot?.publishedRevisionId).toBe(saved.revision.id);
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

    // A deploy can change a block under a draft that was saved when it passed.
    // Publish then re-renders the form with the failing fields inline — the same
    // treatment a refused save gets — rather than a generic notice.
    test("re-renders with the failing field when the draft no longer validates", async () => {
      // Written directly so the save layer's validation doesn't reject it.
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

      expect(res.status).toBe(200);
      const html = await res.text();
      // The save form's own banner and per-field error state, not `?publish=`,
      // and the banner names the action that was refused: a publish.
      expect(html).toContain("This content can't be published");
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain('href="#cms-field-heading"');

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
    // One entry per revision, newest first. Parsing the list's items beats
    // splitting on a class string: an attribute reorder or an extra class
    // doesn't silently turn the whole thing into one row.
    const historyRows = (html: string): string[] =>
      [...html.matchAll(/<li class="cms-history-item"[\s\S]*?<\/li>/g)].map(
        (match) => match[0],
      );

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
      // Its own revision can't be restored: the newest row offers no restore.
      expect(newest).not.toContain(`value="${second.id}"`);
      // The older revision is published and offers a restore, naming its id.
      expect(older).toContain("cms-history-published");
      expect(older).toContain("Published");
      expect(older).not.toContain("Current draft");
      expect(older).toContain(`value="${first.id}"`);
    });

    // Part 5, end to end: save, restore an older revision, publish the copy.
    // The row the copy came from must not keep saying "Current draft", and the
    // copy is a revision of its own — not a second row for the same thing.
    test("drops the Current draft label from every row once a restore is published", async () => {
      const first = await draft("First");
      await draft("Second");

      await slotPublish.restore(
        await postForm(
          restorePath(slotId),
          slotId,
          { revision: first.id },
          sessionId,
        ),
      );
      const restored = await getLatestRevision("slot", slotId);
      if (!restored) throw new Error("restore did not write a revision");

      await slotPublish.publish(
        await postForm(
          publishPath(slotId),
          slotId,
          { revision: restored.id },
          sessionId,
        ),
      );

      const rows = historyRows(
        await (
          await slotHistory.index(
            request(historyPath(slotId), slotId, {
              method: "GET",
              headers: { cookie: `cms_session=${sessionId}` },
            }),
          )
        ).text(),
      );

      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("Published");
      expect(rows[0]).not.toContain("Current draft");
      expect(rows.filter((row) => row.includes("Current draft"))).toHaveLength(
        0,
      );
      // One row per revision: the restored copy and its source both remain, and
      // each revision id appears once.
      const ids = rows.flatMap((row) => [
        ...row.matchAll(/name="revision" value="([^"]+)"/g),
      ]);
      expect(new Set(ids.map((match) => match[1])).size).toBe(ids.length);
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
      // A static empty state, not a live-region warning.
      expect(html).not.toContain("flash-warning");
      expect(html).not.toContain("Show older");
    });

    test("pages the list at the newest 50, linking older pages with ?before=", async () => {
      const total = HISTORY_PAGE_SIZE + 3;
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      for (let i = 0; i < total; i += 1) {
        await db`
          INSERT INTO cms_revisions
            (id, target_type, target_id, content, created_by, created_at)
          VALUES (
            ${randomUUID()},
            'slot',
            ${slotId},
            ${jsonbValue({ heading: `#${i}` })},
            ${editorId},
            ${new Date(base + i * 1000)}
          )
        `;
      }

      const res = await slotHistory.index(
        request(historyPath(slotId), slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );
      expect(res.status).toBe(200);
      const html = await res.text();

      const rows = historyRows(html);
      expect(rows).toHaveLength(HISTORY_PAGE_SIZE);
      // Only the first page marks the newest revision as the current draft.
      expect(rows[0]).toContain("Current draft");

      const link = html.match(/href="([^"]*\/history\?before=[^"]+)"/);
      expect(link).not.toBeNull();
      const olderHref = (link as RegExpMatchArray)[1];
      expect(olderHref).toContain("?before=");

      // The cursor is the oldest revision on the page, and the next page holds
      // the rest, with no "Show older" and no current-draft badge.
      const older = await slotHistory.index(
        request(olderHref, slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );
      expect(older.status).toBe(200);
      const olderHtml = await older.text();
      expect(historyRows(olderHtml)).toHaveLength(total - HISTORY_PAGE_SIZE);
      expect(olderHtml).not.toContain("Show older");
      expect(olderHtml).not.toContain("Current draft");
    });

    test("ignores a malformed before cursor rather than 500ing", async () => {
      const res = await slotHistory.index(
        request(`${historyPath(slotId)}?before=not-a-uuid`, slotId, {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
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
