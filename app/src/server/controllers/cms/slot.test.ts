import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import {
  block,
  image,
  link,
  list,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { createMemoryStorage } from "@alexpricedev/billet-storage";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { makeJpeg } from "../../test-utils/images";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { hashPreviewToken } from "@alexpricedev/billet-cms/preview";
import {
  createRevision,
  publishSlot,
  saveSlotDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createMedia, listMediaOptions } from "../../services/media";
import { MEDIA_PICKER_LIMIT } from "../../services/media/limits";
import { createAuthenticatedSession } from "../../services/sessions";
import { staleCsrfToken } from "../../test-utils/auth-form";
import { createBunRequest } from "../../test-utils/bun-request";
import { MAX_CONTENT_BYTES } from "./params";
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

// A slot whose block carries an image, so a save can name a media id the picker
// then has to carry.
const photoHero = block("photoHero", { photo: image() }, () => null);

// Part 10: a field with a minimum width. A narrower image warns but saves.
const narrowHero = block(
  "narrowHero",
  { photo: image({ minWidth: 1600 }) },
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

/** Whether the Preview draft button rendered disabled. */
const previewDisabled = (html: string): boolean =>
  /<button[^>]*class="[^"]*cms-preview-button[^"]*"[^>]*disabled/.test(html);

/** The contents of the form's one options template, or "" when it has none. */
const mediaOptionsTemplate = (html: string): string =>
  html.match(/<template data-media-options[^>]*>([\s\S]*?)<\/template>/)?.[1] ??
  "";

/** Seed `count` uploads, oldest first. */
const seedUploads = async (count: number): Promise<void> => {
  const storage = createMemoryStorage();
  for (let index = 0; index < count; index += 1) {
    const result = await createMedia({
      bytes: await makeJpeg(60, 40),
      alt: `Upload ${index}`,
      actorId: null,
      storage,
    });
    if (!result.ok) throw new Error("upload seed failed");
  }
};

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

    test("shows the page group and slot label in the breadcrumb, key on a muted line", async () => {
      const footerId = await seedSlot(db, {
        name: "footer.cta",
        blockName: "hero",
        page: "footer",
        label: "Footer call to action",
      });
      const html = await (
        await slotForm.index(
          createBunRequest(
            `${ORIGIN}${path(footerId)}`,
            {
              method: "GET",
              headers: { cookie: `cms_session=${sessionId}` },
            },
            { id: footerId },
          ),
        )
      ).text();
      const crumb = html.match(/class="cms-breadcrumb"[^>]*>(.*?)<\/p>/s)?.[1];
      expect(crumb?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toBe(
        "Content / Footer / Footer call to action",
      );
      expect(html).not.toContain("<span>footer</span>");
      expect(html).not.toContain("Slot <code>");
      expect(html).toContain(
        '<p class="cms-slot-meta"><code>footer.cta</code> · block <code>hero</code></p>',
      );
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

    test("carries a referenced image older than the picker cap and shows the help line", async () => {
      await seedBlockType(db, photoHero);
      const photoSlotId = await seedSlot(db, {
        name: "home.photo",
        blockName: "photoHero",
        page: "home",
      });

      await seedUploads(MEDIA_PICKER_LIMIT + 1);
      const options = await listMediaOptions({ limit: MEDIA_PICKER_LIMIT + 1 });
      // The picker reads one row past the cap, so the last row is the one the
      // newest list leaves out.
      const oldest = options[MEDIA_PICKER_LIMIT];

      const saved = await saveSlotDraft({
        slotId: photoSlotId,
        content: { photo: { mediaId: oldest.id } },
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");

      const res = await slotForm.index(
        createBunRequest(
          `${ORIGIN}${path(photoSlotId)}`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: photoSlotId },
        ),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      // The library was bigger than the cap, so the "older ones" line is true...
      expect(html).toContain(
        `Showing the newest ${MEDIA_PICKER_LIMIT} uploads`,
      );
      // ...and the referenced image outside the cap still carries its label.
      expect(mediaOptionsTemplate(html)).toContain(
        `${oldest.alt} (${oldest.width}×${oldest.height})`,
      );
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
    test("asks before publishing, and Save draft is not gated", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("save failed");

      const html = await (await slotForm.index(get())).text();
      expect(html).toContain(
        'data-confirm="The site picks it up within seconds."',
      );
      expect(html).toMatch(/data-confirm-title="Publish '[^"]+'\?"/);
      expect(html).toContain('data-confirm-label="Publish"');
      expect(html).toContain('data-confirm-danger="false"');
      expect(html.match(/data-confirm=/g)).toHaveLength(1);
    });

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

  // Parts 1-3: the bar says what is live and what is draft, Publish is the
  // primary button when it would do something, and a disabled button says why.
  describe("action bar", () => {
    const statusOf = (html: string): string =>
      html.match(/class="cms-publish-status"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";

    const publishButton = (html: string): string =>
      html.match(
        /<button[^>]*class="[^"]*cms-publish-button[^"]*"[^>]*>/,
      )?.[0] ?? "";

    const saveButton = (html: string): string =>
      html.match(/<button[^>]*class="[^"]*cms-save[^"]*"[^>]*>/)?.[0] ?? "";

    test("says no draft is saved and why both buttons are off", async () => {
      const html = await (await slotForm.index(get())).text();

      expect(statusOf(html)).toBe("No draft saved yet.");
      expect(html).toContain("Nothing to publish: no draft saved yet.");
      expect(html).toContain("No draft to preview.");
      expect(publishButton(html)).toContain("disabled");
      expect(publishButton(html)).toContain(
        'aria-describedby="publish-reason"',
      );
      expect(previewDisabled(html)).toBe(true);
    });

    test("says what the saved draft is when nothing is live", async () => {
      const saved = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");

      const html = await (await slotForm.index(get())).text();

      expect(statusOf(html)).toMatch(
        /^Not published yet\. Draft saved \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\.$/,
      );
      // Unpublished changes: Publish is the filled action, Save draft the quiet
      // one beside it.
      expect(publishButton(html)).toContain("btn-primary");
      expect(publishButton(html)).not.toContain("disabled");
      expect(saveButton(html)).toContain("btn-secondary");
      expect(html).not.toContain("Nothing to publish");
    });

    test("says what is live once the draft is published", async () => {
      const saved = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");
      await publishSlot({ slotId, revisionId: saved.revision.id });

      const html = await (await slotForm.index(get())).text();

      expect(statusOf(html)).toMatch(
        /^Live since \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\. No unpublished changes\.$/,
      );
      expect(html).toContain("Nothing to publish: no unpublished changes.");
      expect(html).toContain("Nothing to preview: no unpublished changes.");
      expect(publishButton(html)).toContain("disabled");
      expect(publishButton(html)).toContain("btn-secondary");
      // With nothing to publish, saving is the action that does something.
      expect(saveButton(html)).toContain("btn-primary");
    });

    test("names both times when a newer draft sits on a published one", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("first save failed");
      await publishSlot({ slotId, revisionId: first.revision.id });
      const second = await saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "Newer" },
        baseRevisionId: first.revision.id,
        actorId: editorId,
      });
      if (!second.ok) throw new Error("second save failed");

      const html = await (await slotForm.index(get())).text();

      expect(statusOf(html)).toMatch(
        /^Live since \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\. Draft saved \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC, not published yet\.$/,
      );
      expect(publishButton(html)).toContain("btn-primary");
    });

    // Moving Save draft out of the form must not orphan it: `form` is what
    // keeps it a submit of the form whose content the client serialises.
    test("keeps Save draft a submit of the content form", async () => {
      const html = await (await slotForm.index(get())).text();

      expect(saveButton(html)).toContain('form="cms-slot-form"');
      expect(html).toContain('id="cms-slot-form"');
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

    // The editor pressed Preview, was asked to save on the way, and said yes:
    // finishing on the form would hand them the button to press again.
    test("carries on to the preview when the save was on the way to one", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: "",
          after: "preview",
        }),
      );

      expect(res.status).toBe(303);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith(`${process.env.SITE_APP_URL}/`)).toBe(true);
      expect(location).toContain("cms_preview=");

      // The draft is written either way: the preview is the second half of the
      // save, not an alternative to it.
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(1);
      expect(await db`SELECT id FROM cms_preview_tokens`).toHaveLength(1);
    });

    test("still returns to the form on an ordinary save", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: "",
          after: "",
        }),
      );

      expect(res.headers.get("location")).toBe(`${path(slotId)}?saved=1`);
      expect(await db`SELECT id FROM cms_preview_tokens`).toHaveLength(0);
    });

    // A save that cannot be stored must not mint a preview for content that
    // was never written.
    test("does not preview a save that failed validation", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: 5 }),
          base_revision: "",
          after: "preview",
        }),
      );

      expect(res.status).toBe(200);
      expect(await db`SELECT id FROM cms_preview_tokens`).toHaveLength(0);
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
      expect(html).toContain("Couldn't save draft.");
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

    test("says a posted document over the size cap is too large, not unreadable", async () => {
      const seeded = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!seeded.ok) throw new Error("seed save failed");

      const oversized = JSON.stringify({
        ...validContent,
        heading: "x".repeat(MAX_CONTENT_BYTES),
      });
      expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
        MAX_CONTENT_BYTES,
      );

      const res = await slotForm.create(
        await post({
          content: oversized,
          base_revision: seeded.revision.id,
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("too large to save");
      expect(html).not.toContain("could not be read");
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

      // A re-render — a save that fails validation — posts only the declared
      // fields, so the notice has to be read back from the revision the editor
      // loaded rather than from the posted document. Otherwise it vanishes the
      // moment a save fails.
      const invalid = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: "x".repeat(81) }),
          base_revision: seeded.id,
        }),
      );
      expect(invalid.status).toBe(200);
      const invalidHtml = await invalid.text();
      expect(invalidHtml).toContain("Couldn't save draft.");
      expect(invalidHtml).toContain("droppedField");

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

    // The first save can lose a race too: the form loaded with nothing saved
    // yet, so it posts no base revision, but someone has saved one since.
    test("warns when the first revision was saved while the form was open", async () => {
      const first = await saveSlotDraft({
        slotId,
        content: { ...validContent, heading: "Theirs" },
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!first.ok) throw new Error("first save failed");

      const res = await slotForm.create(
        await post({
          content: JSON.stringify({ ...validContent, heading: "Mine" }),
          base_revision: "",
        }),
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("newer version");
      expect(html).toContain("editor@example.com");
      // The form now points at their revision, so a second save overwrites.
      expect(hiddenValue(html, "base_revision")).toBe(first.revision.id);
      // The editor's work is kept.
      expect(html).toContain("Mine");

      const latest = await db`
        SELECT content FROM cms_revisions ORDER BY created_at DESC, id DESC LIMIT 1
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

    // Part 10: a narrow image used to refuse the save. It saves, and the
    // editor is told on the page the redirect lands on.
    test("saves a too-narrow image and says so on the way back", async () => {
      await seedBlockType(db, narrowHero);
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

      const formData = new FormData();
      formData.append(
        "_csrf",
        await createCsrfToken(sessionId, "POST", path(narrowSlotId)),
      );
      formData.append(
        "content",
        JSON.stringify({ photo: { mediaId: small.media.id } }),
      );
      formData.append("base_revision", "");

      const res = await slotForm.create(
        createBunRequest(
          `${ORIGIN}${path(narrowSlotId)}`,
          {
            method: "POST",
            headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
            body: formData,
          },
          { id: narrowSlotId },
        ),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${path(narrowSlotId)}?saved=1&warn=1`,
      );
      // It really is saved, not merely not-refused.
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(1);

      const html = await (
        await slotForm.index(
          createBunRequest(
            `${ORIGIN}${path(narrowSlotId)}?saved=1&warn=1`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: narrowSlotId },
          ),
        )
      ).text();
      expect(html).toContain('data-tone="warning"');
      expect(html).toContain("Draft saved.");
      expect(html).toContain("narrower than its field wants");
    });

    test("a clean save says nothing about images", async () => {
      const res = await slotForm.create(
        await post({
          content: JSON.stringify(validContent),
          base_revision: "",
        }),
      );

      expect(res.headers.get("location")).toBe(`${path(slotId)}?saved=1`);
    });
  });

  describe("preview", () => {
    test("disables Preview draft once the draft is already live", async () => {
      // Nothing saved yet: there is no draft to preview.
      expect(previewDisabled(await (await slotForm.index(get())).text())).toBe(
        true,
      );

      const saved = await saveSlotDraft({
        slotId,
        content: validContent,
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");

      // A saved draft that isn't live: preview is available.
      expect(previewDisabled(await (await slotForm.index(get())).text())).toBe(
        false,
      );

      await publishSlot({ slotId, revisionId: saved.revision.id });

      // The draft is now the published revision: nothing left to preview.
      expect(previewDisabled(await (await slotForm.index(get())).text())).toBe(
        true,
      );
    });

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

    test("checks the site URL before minting, so a bad one writes no token", async () => {
      const formData = new FormData();
      formData.append(
        "_csrf",
        await createCsrfToken(sessionId, "POST", `${path(slotId)}/preview`),
      );

      // A process with no site URL (validateEnv refuses to boot one, but a unit
      // test or a mis-set variable can reach here) must not write a token it
      // has nowhere to open.
      const original = process.env.SITE_APP_URL;
      process.env.SITE_APP_URL = "";
      let res: Response;
      try {
        res = await slotPublish.preview(
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
      } finally {
        process.env.SITE_APP_URL = original;
      }

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${path(slotId)}?preview=failed`,
      );
      const rows = await db`SELECT id FROM cms_preview_tokens`;
      expect(rows).toHaveLength(0);
    });

    test("a failed mint redirects with a notice, not an HTML 500", async () => {
      const formData = new FormData();
      formData.append(
        "_csrf",
        await createCsrfToken(sessionId, "POST", `${path(slotId)}/preview`),
      );

      // Break the mint the way an unreachable database would. Renamed rather
      // than dropped so every later test finds the table where it left it.
      await db`ALTER TABLE cms_preview_tokens RENAME TO cms_preview_tokens_broken`;
      let res: Response;
      try {
        res = await slotPublish.preview(
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
      } finally {
        await db`ALTER TABLE cms_preview_tokens_broken RENAME TO cms_preview_tokens`;
      }

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${path(slotId)}?preview=failed`,
      );

      const html = await (
        await slotForm.index(
          createBunRequest(
            `${ORIGIN}${path(slotId)}?preview=failed`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: slotId },
          ),
        )
      ).text();
      expect(html).toContain("create a preview link");
    });
  });
});
