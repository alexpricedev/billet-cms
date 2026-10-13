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

import { hashPreviewToken } from "@alexpricedev/billet-cms/preview";
import { createRevision, saveSlotDraft } from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { staleCsrfToken } from "../../test-utils/auth-form";
import { createBunRequest } from "../../test-utils/bun-request";
import { slotPublish } from "./publish";
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

/** The value of a hidden input the form rendered, by field name. */
const hiddenValue = (html: string, name: string): string | undefined =>
  html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

/**
 * The save form's CSRF token. Several forms render a `_csrf` on the page (the
 * nav's sign-out, the publish button), so this reads the one inside the form
 * that carries the content rather than assuming which comes last.
 */
const saveFormCsrf = (html: string): string | undefined =>
  html.match(/data-cms-form[\s\S]*?name="_csrf" value="([^"]*)"/)?.[1];

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

  const rawPost = async (
    fields: Record<string, string>,
    session = sessionId,
    csrf?: string,
  ) => {
    const formData = new FormData();
    formData.append(
      "_csrf",
      csrf ?? (await createCsrfToken(session, "POST", path(slotId))),
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

  const post = (fields: Record<string, string>, session = sessionId) =>
    rawPost(fields, session);

  describe("GET", () => {
    test("redirects an anonymous visitor to sign in", async () => {
      const res = await slotForm.index(get(""));

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/sign-in");
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

    test("names its controls for assistive technology", async () => {
      const html = await (await slotForm.index(get())).text();

      // A label for the text control; a fieldset/legend for the composites.
      expect(html).toContain(
        '<label class="cms-field-label" for="cms-field-heading"',
      );
      expect(html).toContain('id="cms-field-heading"');
      expect(html).toContain('<legend class="cms-field-label">');
      // The rich text editor is a labelled, multiline textbox.
      expect(html).toContain('role="textbox"');
      expect(html).toContain('aria-multiline="true"');
      // And the toolbar buttons say what they do.
      expect(html).toContain('aria-label="Bold"');
      expect(html).toContain('aria-controls="cms-field-body"');
    });

    test("renders a 404 for a slot that does not exist", async () => {
      const req = createBunRequest(
        `${ORIGIN}/cms/slots/00000000-0000-4000-8000-000000000000`,
        { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
      );
      const res = await slotForm.index(req);
      expect(res.status).toBe(404);
    });

    test("renders a 404 for a slot id that is not a UUID", async () => {
      const req = createBunRequest(`${ORIGIN}/cms/slots/not-a-uuid`, {
        method: "GET",
        headers: { cookie: `cms_session=${sessionId}` },
      });
      const res = await slotForm.index(req);
      expect(res.status).toBe(404);
    });

    test("flags a removed slot but still lets it be edited", async () => {
      await db`UPDATE cms_slots SET removed_at = NOW() WHERE id = ${slotId}`;

      const html = await (await slotForm.index(get())).text();

      expect(html).toContain("no longer declared in the site's templates");
      expect(html).toContain("data-cms-form");
    });

    test("makes a removed block type read-only", async () => {
      await db`
        UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'
      `;

      const html = await (await slotForm.index(get())).text();

      expect(html).toContain("no longer published");
      expect(html).not.toContain("data-cms-form");
    });

    // The publish form posts the revision it rendered, so it must name the
    // real newest revision rather than whatever base the last POST carried.
    test("points the publish form at the newest revision", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("first save failed");

      const otherId = (await seedIdentity(db, "other@example.com")).id;
      const second = await saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "Theirs" },
        baseRevisionId: first.revision.id,
        actorId: otherId,
      });
      if (!second.ok) throw new Error("second save failed");

      const html = await (await slotForm.index(get())).text();
      expect(hiddenValue(html, "revision")).toBe(second.revision.id);
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
      // The field's own label, not its machine name.
      expect(html).toContain("Heading");
      expect(html).toContain('aria-invalid="true"');
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
    });

    test("recovers an expired page instead of losing the work", async () => {
      const res = await slotForm.create(
        await rawPost(
          {
            content: JSON.stringify({ ...validContent, heading: "Kept" }),
            base_revision: "",
          },
          sessionId,
          await staleCsrfToken(sessionId, path(slotId)),
        ),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("This page expired");
      // The posted content is still in the form...
      expect(html).toContain("Kept");
      // ...behind a fresh token, so saving again works.
      expect(hiddenValue(html, "_csrf")).toBeTruthy();
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
    });

    test("falls back to the base revision when the content cannot be read", async () => {
      const seeded = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!seeded.ok) throw new Error("seed save failed");

      const res = await slotForm.create(
        await post({
          content: "{not json",
          base_revision: seeded.revision.id,
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("could not be read");
      // The base revision's content, not an empty form.
      expect(html).toContain("A heading");
    });

    test("keeps a removed field's value and flags it", async () => {
      // A revision written before the field was dropped. Written directly so the
      // strict validator doesn't reject the very key under test.
      const seeded = await createRevision({
        targetType: "slot",
        targetId: slotId,
        content: { ...validContent, droppedField: { kept: true } },
        createdBy: editorId,
      });

      const getHtml = await (await slotForm.index(get())).text();
      expect(getHtml).toContain("no longer defined in code");
      expect(getHtml).toContain("droppedField");

      // The client no longer sends removed fields; the server carries them
      // through from the revision the editor loaded.
      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: seeded.id,
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
      const second = await saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "Theirs" },
        baseRevisionId: first.revision.id,
        actorId: otherId,
      });
      if (!second.ok) throw new Error("second save failed");

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
      expect(html).toContain("Load their version");
      // No blind-overwrite flag: the form now points its base at theirs.
      expect(html).not.toContain('name="overwrite"');
      expect(hiddenValue(html, "base_revision")).toBe(second.revision.id);
      // The editor's work is still in the form.
      expect(html).toContain("Mine");

      // Nothing written until the editor confirms.
      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
      `;
      expect(latest[0].content.heading).toBe("Theirs");
    });

    test("overwrites once the editor confirms, using the re-rendered base", async () => {
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

      // First attempt conflicts and comes back with their revision as the base.
      const conflict = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: "Mine" }),
          base_revision: first.revision.id,
        }),
      );
      expect(conflict.status).toBe(200);
      const conflictHtml = await conflict.text();

      const base = hiddenValue(conflictHtml, "base_revision") ?? "";
      const csrf = saveFormCsrf(conflictHtml) ?? "";
      expect(base).toBeTruthy();
      expect(csrf).toBeTruthy();

      // Saving again with that base is a deliberate overwrite.
      const res = await slotForm.create(
        await rawPost(
          {
            content: JSON.stringify({ ...validContent, heading: "Mine" }),
            base_revision: base,
          },
          sessionId,
          csrf,
        ),
      );

      expect(res.status).toBe(303);
      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
      `;
      expect(latest[0].content.heading).toBe("Mine");
    });
  });

  describe("preview", () => {
    test("offers a Preview button and mints a token for the slot's page", async () => {
      const html = await (await slotForm.index(get())).text();
      expect(html).toContain(`action="${path(slotId)}/preview"`);

      const formData = new FormData();
      formData.append(
        "_csrf",
        await createCsrfToken(sessionId, "POST", `${path(slotId)}/preview`),
      );
      const res = await slotPublish.preview(
        createBunRequest(
          `${ORIGIN}${path(slotId)}/preview`,
          {
            method: "POST",
            headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
            body: formData,
          },
          { id: slotId },
        ),
      );

      expect(res.status).toBe(303);
      const location = res.headers.get("location") ?? "";
      // `seedSlot` defaults the preview path to the site root.
      expect(location.startsWith("http://localhost:4000/?cms_preview=")).toBe(
        true,
      );
      const raw = new URL(location).searchParams.get("cms_preview") ?? "";
      expect(raw).not.toBe("");

      const rows = (await db`
        SELECT subject_type, subject_id, token_hash FROM cms_preview_tokens
      `) as { subject_type: string; subject_id: string; token_hash: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].subject_type).toBe("slot");
      expect(rows[0].subject_id).toBe(slotId);
      // Only the hash is stored, never the raw token.
      expect(rows[0].token_hash).toBe(hashPreviewToken(raw));
    });
  });
});
