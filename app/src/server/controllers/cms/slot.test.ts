import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import {
  block,
  link,
  list,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { saveSlotDraft } from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { createBunRequest } from "../../test-utils/bun-request";
import { slotForm } from "./slot";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  {
    heading: text({ max: 80, label: "Heading" }),
    body: richText(),
    cta: link({ required: false }),
    tags: list(text(), { max: 4, required: false }),
  },
  () => null,
);

const document: RichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
};

const validContent = {
  heading: "A heading",
  body: document,
  tags: ["one", "two"],
};

const path = (slotId: string) => `/cms/slots/${slotId}`;

describe("Slot form controller", () => {
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

  const get = (session = sessionId) =>
    createBunRequest(
      `${ORIGIN}${path(slotId)}`,
      {
        method: "GET",
        ...(session ? { headers: { cookie: `cms_session=${session}` } } : {}),
      },
      { id: slotId },
    );

  const post = async (fields: Record<string, string>, session = sessionId) => {
    const formData = new FormData();
    formData.append(
      "_csrf",
      await createCsrfToken(session, "POST", path(slotId)),
    );
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    return createBunRequest(
      `${ORIGIN}${path(slotId)}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, cookie: `cms_session=${session}` },
        body: formData,
      },
      { id: slotId },
    );
  };

  describe("GET", () => {
    test("redirects an anonymous visitor to sign in", async () => {
      const res = await slotForm.index(get(""));

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    });

    test("builds the form from the published field metadata", async () => {
      const html = await (await slotForm.index(get())).text();

      expect(html).toContain("data-cms-form");
      expect(html).toContain('data-field-name="heading"');
      expect(html).toContain('data-field-kind="text"');
      expect(html).toContain('data-field-kind="richText"');
      expect(html).toContain('data-field-kind="list"');
      // The stored document rides in the hidden content field.
      expect(html).toContain('name="content"');
    });

    test("renders a 404 for a slot that does not exist", async () => {
      const req = createBunRequest(
        `${ORIGIN}/cms/slots/00000000-0000-4000-8000-000000000000`,
        { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
      );
      const res = await slotForm.index(req);
      expect(res.status).toBe(404);
    });
  });

  describe("POST", () => {
    test("saves a valid draft and redirects back to the form", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: "",
        }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${path(slotId)}?saved=1`);

      const revisions = await db`SELECT id FROM cms_revisions`;
      expect(revisions).toHaveLength(1);
    });

    test("re-renders with the failing field when the content is invalid", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: 5 }),
          base_revision: "",
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/can.{0,5}t be saved/);
      expect(html).toContain("heading");
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
    });

    test("keeps a removed field's value and flags it", async () => {
      // A revision written before the field was dropped.
      const seeded = await saveSlotDraft({
        slotId,
        content: { ...validContent, droppedField: { kept: true } },
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!seeded.ok) throw new Error("seed save failed");

      const getHtml = await (await slotForm.index(get())).text();
      expect(getHtml).toContain("no longer defined in code");
      expect(getHtml).toContain("droppedField");

      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: seeded.revision.id,
          removed_fields: JSON.stringify({ droppedField: { kept: true } }),
        }),
      );

      expect(res.status).toBe(303);
      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
      `;
      expect(latest[0].content.droppedField).toEqual({ kept: true });
    });

    test("warns about a newer revision, naming who saved it", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("first save failed");

      const otherId = (await seedIdentity(db, "other@example.com")).id;
      await saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "Theirs" },
        baseRevisionId: first.revision.id,
        actorId: otherId,
      });

      const res = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: "Mine" }),
          base_revision: first.revision.id,
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("newer version");
      expect(html).toContain("other@example.com");
      expect(html).toContain('name="overwrite"');

      // Nothing written until the editor confirms.
      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
      `;
      expect(latest[0].content.heading).toBe("Theirs");
    });

    test("writes on top once the editor confirms the overwrite", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("first save failed");

      const res = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: "Mine" }),
          base_revision: first.revision.id,
          overwrite: "1",
        }),
      );

      expect(res.status).toBe(303);
      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
      `;
      expect(latest[0].content.heading).toBe("Mine");
    });
  });
});
