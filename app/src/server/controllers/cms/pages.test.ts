import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  block,
  image,
  link,
  MAX_RICH_TEXT_LIST_DEPTH,
  type PageTypeDefinition,
  pageType,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { createBunRequest } from "../../test-utils/bun-request";
import { seedBlockType, seedPageType } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { makeJpeg } from "../../test-utils/images";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import {
  createPage,
  getPageById,
  getPageByUrl,
  listRedirects,
  publishPage,
  savePageDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import {
  createMedia,
  createMemoryMediaStorage,
  listMediaOptions,
} from "../../services/media";
import { MEDIA_PICKER_LIMIT } from "../../services/media/limits";
import { createAuthenticatedSession } from "../../services/sessions";
import { staleCsrfToken } from "../../test-utils/auth-form";
import { pagePublish } from "./page-publish";
import { pages } from "./pages";
import { MAX_CONTENT_BYTES } from "./params";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  {
    heading: text({ max: 80, label: "Heading" }),
    body: richText(),
    cta: link({ required: false, label: "Call to action" }),
  },
  () => null,
);
const prose = block("prose", { body: richText() }, () => null);

const landing: PageTypeDefinition = pageType("landing", {
  allowedBlocks: [hero],
  requiredBlocks: [hero],
  limits: { hero: { max: 1, position: "top" } },
});

// A page type whose allowed blocks a deploy can change out from under a saved
// page — the flag review round 2 makes savable and publishable.
const notes: PageTypeDefinition = pageType("notes", { allowedBlocks: [prose] });

// A page type with an image field, so a save can name a media id the picker
// then has to carry.
const photos = block("photos", { photo: image() }, () => null);
const gallery: PageTypeDefinition = pageType("gallery", {
  allowedBlocks: [photos],
});

const document = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
};

const pageContent = (heading: string) => ({
  blocks: [{ type: "hero", heading, body: document }],
});

/** Whether the Preview draft button rendered disabled. */
const previewDisabled = (html: string): boolean =>
  /<button[^>]*class="cms-preview-button"[^>]*disabled/.test(html);

/** The contents of the form's one options template, or "" when it has none. */
const mediaOptionsTemplate = (html: string): string =>
  html.match(/<template data-media-options[^>]*>([\s\S]*?)<\/template>/)?.[1] ??
  "";

/** Seed `count` uploads, oldest first. */
const seedUploads = async (count: number): Promise<void> => {
  const storage = createMemoryMediaStorage();
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

describe("Pages controller", () => {
  let editorId: string;
  let sessionId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    await seedBlockType(db, hero);
    await seedPageType(db, landing);
    editorId = (await seedIdentity(db, "editor@example.com")).id;
    sessionId = await createAuthenticatedSession(editorId);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  const get = (path: string) =>
    createBunRequest(`${ORIGIN}${path}`, {
      method: "GET",
      headers: { cookie: `cms_session=${sessionId}` },
    });

  const post = async (
    path: string,
    fields: Record<string, string>,
    csrfPath: string,
    params: Record<string, string> = {},
  ) => {
    const formData = new FormData();
    formData.append(
      "_csrf",
      await createCsrfToken(sessionId, "POST", csrfPath),
    );
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    return createBunRequest(
      `${ORIGIN}${path}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
        body: formData,
      },
      params,
    );
  };

  test("lists the pages a site has created", async () => {
    await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });

    const res = await pages.index(get("/cms/pages"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New page");
    expect(html).toContain("About us");
    expect(html).toContain("/about");
  });

  test("redirects an anonymous visitor to sign in", async () => {
    const res = await pages.index(
      createBunRequest(`${ORIGIN}/cms/pages`, { method: "GET" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("creates a page from the new-page form and redirects to it", async () => {
    const res = await pages.create(
      await post(
        "/cms/pages/new",
        {
          pageType: "landing",
          url: "about",
          title: "About us",
          seoDescription: "Who we are.",
          socialImage: "",
        },
        "/cms/pages/new",
      ),
    );

    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/cms\/pages\/[0-9a-f-]+$/);

    const created = await getPageByUrl("/about");
    expect(created?.title).toBe("About us");
    expect(location).toContain(created?.id ?? "missing");
  });

  test("re-renders the new-page form with the failing field", async () => {
    const res = await pages.create(
      await post(
        "/cms/pages/new",
        { pageType: "landing", url: "", title: "" },
        "/cms/pages/new",
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Enter a title");
    expect(html).toContain("Enter a URL");
  });

  test("builds the editor from the page type's blocks and the page's settings", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");

    const res = await pages.form(
      createBunRequest(
        `${ORIGIN}/cms/pages/${created.page.id}`,
        {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        },
        { id: created.page.id },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    // The settings controls, and the block editor generated from the page type.
    expect(html).toContain('name="url"');
    expect(html).toContain('name="title"');
    expect(html).toContain("data-cms-page-content");
    expect(html).toContain('data-block-add="hero"');
    // The link picker's page list is threaded through to the controls.
    expect(html).toContain("data-cms-content");
  });

  test("carries a referenced image older than the picker cap and shows the help line", async () => {
    await seedBlockType(db, photos);
    await seedPageType(db, gallery);
    const created = await createPage({
      pageType: "gallery",
      url: "/gallery",
      title: "Gallery",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    await seedUploads(MEDIA_PICKER_LIMIT + 1);
    const options = await listMediaOptions({ limit: MEDIA_PICKER_LIMIT + 1 });
    // The picker reads one row past the cap, so the last row is the one the
    // newest list leaves out.
    const oldest = options[MEDIA_PICKER_LIMIT];

    const saved = await savePageDraft({
      pageId,
      content: { blocks: [{ type: "photos", photo: { mediaId: oldest.id } }] },
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error("save failed");

    const res = await pages.form(
      createBunRequest(
        `${ORIGIN}/cms/pages/${pageId}`,
        { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    // The library was bigger than the cap, so the "older ones" line is true...
    expect(html).toContain(`Showing the newest ${MEDIA_PICKER_LIMIT} uploads`);
    // ...and the referenced image outside the cap still carries its label.
    expect(mediaOptionsTemplate(html)).toContain(
      `${oldest.alt} (${oldest.width}×${oldest.height})`,
    );
  });

  test("re-renders a mistyped Media id as a field error, not a 500", async () => {
    await seedBlockType(db, photos);
    await seedPageType(db, gallery);
    const created = await createPage({
      pageType: "gallery",
      url: "/gallery",
      title: "Gallery",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "gallery",
          url: "/gallery",
          title: "Gallery",
          content: JSON.stringify({
            blocks: [{ type: "photos", photo: { mediaId: "not-a-uuid" } }],
          }),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    // The save is refused and the editor is shown why: the mistyped id is
    // filtered before the picker's `uuid` query, so the re-render is a 200, not
    // the reported id reaching Postgres and becoming a 500.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-field-name="photo"');
    expect(html).toContain('aria-invalid="true"');
    // The editor sees the plain-language message, not the validator's raw
    // "Invalid UUID": block messages reach the form through `plainMessage` in
    // `services/content/drafts.ts`.
    expect(html).toContain("Enter a valid id.");
    // The editor's typed value comes back, rather than being silently dropped.
    expect(html).toContain("not-a-uuid");
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  test("disables Preview draft once the draft is already live", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const formHtml = async () =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();

    // Nothing saved yet: there is no draft to preview.
    expect(previewDisabled(await formHtml())).toBe(true);

    const saved = await savePageDraft({
      pageId,
      content: pageContent("About us"),
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error("save failed");

    // A saved draft that isn't live: preview is available.
    expect(previewDisabled(await formHtml())).toBe(false);

    await publishPage({ pageId, revisionId: saved.revision.id });

    // The draft is now the published revision: nothing left to preview.
    expect(previewDisabled(await formHtml())).toBe(true);
  });

  test("the editor offers a Preview button that mints a token", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const html = await (
      await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${pageId}`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: pageId },
        ),
      )
    ).text();
    expect(html).toContain(`action="/cms/pages/${pageId}/preview"`);

    const res = await pagePublish.preview(
      await post(
        `/cms/pages/${pageId}/preview`,
        {},
        `/cms/pages/${pageId}/preview`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(
      location.startsWith("http://localhost:4000/about?cms_preview="),
    ).toBe(true);

    const rows = (await db`
      SELECT subject_type, subject_id FROM cms_preview_tokens
    `) as { subject_type: string; subject_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_type).toBe("page");
    expect(rows[0].subject_id).toBe(pageId);
  });

  test("a failed mint redirects with a notice, not an HTML 500", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    // Break the mint the way an unreachable database would: the INSERT has
    // nowhere to land. Renamed rather than dropped so every later test finds
    // the table where it left it.
    await db`ALTER TABLE cms_preview_tokens RENAME TO cms_preview_tokens_broken`;
    let res: Response;
    try {
      res = await pagePublish.preview(
        await post(
          `/cms/pages/${pageId}/preview`,
          {},
          `/cms/pages/${pageId}/preview`,
          { id: pageId },
        ),
      );
    } finally {
      await db`ALTER TABLE cms_preview_tokens_broken RENAME TO cms_preview_tokens`;
    }

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/cms/pages/${pageId}?preview=failed`,
    );

    // The redirect lands on the editor with the notice, not a server error page.
    const html = await (
      await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${pageId}?preview=failed`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: pageId },
        ),
      )
    ).text();
    expect(html).toContain("create a preview link");
  });

  test("an invalid content save writes neither settings nor a redirect", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    // The content half of this submit is invalid (the page type requires a
    // hero), and the settings half renames the page. Nothing should land.
    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about-us",
          title: "Renamed",
          content: JSON.stringify({ blocks: [] }),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    // The editor's typed settings come back, not the stored ones.
    const html = await res.text();
    expect(html).toContain('value="/about-us"');
    expect(html).toContain('value="Renamed"');

    const page = await getPageById(pageId);
    expect(page?.url).toBe("/about");
    expect(page?.title).toBe("About us");
    expect(await listRedirects()).toEqual([]);
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // The page editor shows what a slot editor shows: a block's field issues are
  // rewritten into plain language before they reach the form, so an editor sees
  // "Use 80 characters or fewer." and "Choose a page." rather than the
  // validator's "Too big: expected string to have <=80 characters" and "Invalid
  // UUID" (subtask: the page editor uses the plain-language messages).
  test("shows a block's plain-language field messages, not the validator's", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about",
          title: "About us",
          content: JSON.stringify({
            blocks: [
              {
                type: "hero",
                heading: "x".repeat(81),
                body: document,
                cta: { type: "page", pageId: "" },
              },
            ],
          }),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    // The length limit is a sentence, not the validator's bound.
    expect(html).toContain("Use 80 characters or fewer.");
    expect(html).not.toContain("Too big: expected string");
    // The empty page picker names the field, not the id format.
    expect(html).toContain("Choose a page.");
    expect(html).not.toContain("Invalid UUID");
    // The block carries field errors, so the summary points at the marked
    // blocks (the other half of the whole-document-error behaviour).
    expect(html).toContain("Check the blocks marked below.");
    // Nothing was written.
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // The banner names the marked blocks only when a block really carries a field
  // error: a page-limit issue (`blocks`) has no block to mark, so telling the
  // editor to check marked blocks would send them looking for a highlight that
  // isn't there (review round 2).
  test("points the summary at marked blocks only when one carries a field error", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const save = async (content: unknown): Promise<string> => {
      const res = await pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url: "/about",
            title: "About us",
            content: JSON.stringify(content),
            base_revision: "",
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );
      expect(res.status).toBe(200);
      return res.text();
    };

    // A block with a bad field: the block is marked, so the banner says so.
    const withFieldError = await save({
      blocks: [{ type: "hero", heading: "x".repeat(81), body: document }],
    });
    expect(withFieldError).toContain("This content can't be saved.");
    expect(withFieldError).toContain("Check the blocks marked below.");

    // No hero at all: the page-limit issue has no block to mark, so the banner
    // drops the sentence.
    const limitOnly = await save({ blocks: [] });
    expect(limitOnly).toContain("This content can't be saved.");
    expect(limitOnly).not.toContain("Check the blocks marked below.");

    // Nothing was written.
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // A whole-block issue (`blocks.N`, with no field path) has no control to mark,
  // so the summary names the block by position and type — otherwise a page
  // with several blocks gives no clue which one the rich text message is about
  // (review round 2). The bad block is second, so a summary that always named
  // block 1 fails.
  test("names the block a whole-block issue belongs to", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    // A document nested one level past the list bound: the validator reports a
    // single issue at the block (`blocks.1`), with no field path.
    let node: unknown = { type: "paragraph", content: [] };
    for (let level = 0; level <= MAX_RICH_TEXT_LIST_DEPTH; level += 1) {
      node = {
        type: "bulletList",
        content: [{ type: "listItem", content: [node] }],
      };
    }

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about",
          title: "About us",
          content: JSON.stringify({
            blocks: [
              {
                type: "hero",
                heading: "Hi",
                body: { type: "doc", content: [] },
              },
              {
                type: "hero",
                heading: "Again",
                body: { type: "doc", content: [node] },
              },
            ],
          }),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `Block 2 (hero): Rich text lists may nest at most ${MAX_RICH_TEXT_LIST_DEPTH} deep.`,
    );
    expect(html).not.toContain("Block 1");
    // The issue is whole-block, so no block is marked and the banner must not
    // point at marked blocks that aren't there.
    expect(html).not.toContain("Check the blocks marked below.");
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  test("an over-size content save says so and keeps the base revision", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const seeded = await savePageDraft({
      pageId,
      content: pageContent("Kept heading"),
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!seeded.ok) throw new Error("seed save failed");

    const oversized = JSON.stringify({
      blocks: [
        {
          type: "hero",
          heading: "x".repeat(MAX_CONTENT_BYTES),
          body: document,
        },
      ],
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
      MAX_CONTENT_BYTES,
    );

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/renamed",
          title: "Renamed",
          seoDescription: "Kept description.",
          socialImage: "https://example.com/og.png",
          content: oversized,
          base_revision: seeded.revision.id,
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    // Says why, and does not silently keep the stored content (review round 2).
    expect(html).toContain("too large to save");
    expect(html).not.toContain("could not be read");
    // The revision they loaded is still on screen.
    expect(html).toContain("Kept heading");
    // The settings half of the same submit survives the refusal (review round
    // 1): the editor sees what they typed, not the stored row.
    expect(html).toContain('value="/renamed"');
    expect(html).toContain('value="Renamed"');
    expect(html).toContain("Kept description.");
    expect(html).toContain('value="https://example.com/og.png"');
    // No block carries a field error here — the body is over the size cap, not
    // a field — so the banner must not point at blocks that aren't marked
    // (review round 1).
    expect(html).not.toContain("Check the blocks marked below.");
    // Nothing was written.
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(1);
  });

  // Review follow-up: a refusal must not throw away the settings half of the
  // submit. The content half here can't be parsed, so the fallback re-renders
  // the editor — with the settings the editor typed, not the stored ones.
  test("keeps the editor's settings when the posted content can't be read", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/renamed",
          title: "Renamed",
          seoDescription: "Kept description.",
          socialImage: "https://example.com/og.png",
          content: "{not json",
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("could not be read");
    expect(html).toContain('value="/renamed"');
    expect(html).toContain('value="Renamed"');
    expect(html).toContain("Kept description.");
    expect(html).toContain('value="https://example.com/og.png"');

    // Nothing was written: the stored settings are untouched.
    const page = await getPageById(pageId);
    expect(page?.url).toBe("/about");
    expect(page?.title).toBe("About us");
  });

  // Both early refusals (unreadable content, an expired page) re-render the
  // editor. The blocks must come from the page type the editor chose, not the
  // page's stored type, so the form they see matches their pick (review round
  // 1).
  test("builds the editor from the posted page type on an early refusal", async () => {
    await seedBlockType(db, prose);
    await seedPageType(db, notes);

    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    // Unreadable content: the `!submitted.ok` refusal.
    const unreadable = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "notes",
          url: "/about",
          title: "About us",
          content: "{not json",
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(unreadable.status).toBe(200);
    const unreadableHtml = await unreadable.text();
    // The notes page type's blocks are offered, not the stored landing type's.
    expect(unreadableHtml).toContain('data-block-add="prose"');
    expect(unreadableHtml).not.toContain('data-block-add="hero"');

    // An expired page: the `!csrf.ok` refusal.
    const formData = new FormData();
    formData.append(
      "_csrf",
      await staleCsrfToken(sessionId, `/cms/pages/${pageId}`),
    );
    formData.append("pageType", "notes");
    formData.append("url", "/about");
    formData.append("title", "About us");
    formData.append("content", JSON.stringify({ blocks: [] }));
    formData.append("base_revision", "");
    const expired = await pages.save(
      createBunRequest(
        `${ORIGIN}/cms/pages/${pageId}`,
        {
          method: "POST",
          headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
          body: formData,
        },
        { id: pageId },
      ),
    );
    expect(expired.status).toBe(200);
    const expiredHtml = await expired.text();
    expect(expiredHtml).toContain("This page expired");
    expect(expiredHtml).toContain('data-block-add="prose"');
    expect(expiredHtml).not.toContain('data-block-add="hero"');
  });

  test("keeps the editor's settings when the page expired while it was open", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const formData = new FormData();
    formData.append(
      "_csrf",
      await staleCsrfToken(sessionId, `/cms/pages/${pageId}`),
    );
    formData.append("pageType", "landing");
    formData.append("url", "/renamed");
    formData.append("title", "Renamed");
    formData.append("socialImage", "https://example.com/og.png");
    formData.append("content", JSON.stringify(pageContent("New heading")));
    formData.append("base_revision", "");

    const res = await pages.save(
      createBunRequest(
        `${ORIGIN}/cms/pages/${pageId}`,
        {
          method: "POST",
          headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
          body: formData,
        },
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This page expired");
    expect(html).toContain('value="/renamed"');
    expect(html).toContain('value="Renamed"');
    expect(html).toContain('value="https://example.com/og.png"');
    // The content they posted is still shown, behind a fresh token.
    expect(html).toContain("New heading");
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  test("writes a redirect when the URL changes", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const save = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about-us",
          title: "About us",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(save.status).toBe(303);
    expect(save.headers.get("location")).toBe(`/cms/pages/${pageId}?saved=1`);
    expect(await getPageByUrl("/about-us")).not.toBeNull();
    expect(await getPageByUrl("/about")).toBeNull();
    const redirects = await listRedirects();
    expect(redirects.map((redirect) => redirect.fromPath)).toContain("/about");
  });

  test("refuses a stale save, then overwrites once the editor confirms", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const first = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about",
          title: "About us",
          content: JSON.stringify(pageContent("First")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(first.status).toBe(303);
    const firstRevision = (
      await db`SELECT id FROM cms_revisions ORDER BY created_at DESC LIMIT 1`
    )[0].id as string;

    // A colleague saves on top. The editor's form still names the first base.
    const other = (await seedIdentity(db, "other@example.com")).id;
    const second = await savePageDraft({
      pageId,
      content: pageContent("Theirs"),
      baseRevisionId: firstRevision,
      actorId: other,
    });
    if (!second.ok) throw new Error("second save failed");

    const conflict = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about",
          title: "About us",
          content: JSON.stringify(pageContent("Mine")),
          base_revision: firstRevision,
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(conflict.status).toBe(200);
    const conflictHtml = await conflict.text();
    expect(conflictHtml).toContain("newer version");
    expect(conflictHtml).toContain("other@example.com");

    // Nothing written until the editor confirms: the newest revision is theirs.
    const newest = await db`
      SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
    `;
    expect(newest[0].content.blocks[0].heading).toBe("Theirs");

    // The re-rendered form points its base at theirs — saving again overwrites.
    const base = conflictHtml.match(
      /name="base_revision" value="([^"]*)"/,
    )?.[1];
    const csrf = conflictHtml.match(
      /data-cms-form[\s\S]*?name="_csrf" value="([^"]*)"/,
    )?.[1];
    expect(base).toBe(second.revision.id);
    expect(csrf).toBeTruthy();

    const formData = new FormData();
    formData.append("_csrf", csrf ?? "");
    for (const [key, value] of Object.entries({
      pageType: "landing",
      url: "/about",
      title: "About us",
      content: JSON.stringify(pageContent("Mine")),
      base_revision: base ?? "",
    })) {
      formData.append(key, value);
    }
    const overwrite = await pages.save(
      createBunRequest(
        `${ORIGIN}/cms/pages/${pageId}`,
        {
          method: "POST",
          headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
          body: formData,
        },
        { id: pageId },
      ),
    );
    expect(overwrite.status).toBe(303);
    const latest = await db`
      SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
    `;
    expect(latest[0].content.blocks[0].heading).toBe("Mine");
  });

  test("refuses a page type that isn't published rather than failing", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "not-a-type",
          url: "/about",
          title: "About us",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Choose a published page type");
    // The page keeps the type it had; nothing was written under the bad one.
    expect((await getPageByUrl("/about"))?.pageType).toBe("landing");
  });

  test("shows a notice after a page is deleted", async () => {
    const res = await pages.index(
      createBunRequest(`${ORIGIN}/cms/pages?deleted=1`, {
        method: "GET",
        headers: { cookie: `cms_session=${sessionId}` },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Page deleted.");
  });

  test("publishes a page", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/about",
          title: "About us",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );

    const res = await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/cms/pages/${pageId}?published=1`,
    );
  });

  test("saves and publishes a page that holds a not-allowed block", async () => {
    await seedBlockType(db, prose);
    await seedPageType(db, notes);

    const created = await createPage({
      pageType: "notes",
      url: "/notes",
      title: "Notes",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    // The page type disallows hero, but the block type is published and
    // renderable, so the save and the publish both let it through (review
    // round 2) rather than stranding the page.
    const save = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "notes",
          url: "/notes",
          title: "Notes",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(save.status).toBe(303);

    const published = await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    expect(published.status).toBe(303);
    expect(published.headers.get("location")).toBe(
      `/cms/pages/${pageId}?published=1`,
    );
    expect((await getPageById(pageId))?.publishedRevisionId).not.toBeNull();
  });

  test("removing a flagged block drops it and lets the page publish", async () => {
    await seedBlockType(db, prose);
    await seedPageType(db, notes);

    const created = await createPage({
      pageType: "notes",
      url: "/notes",
      title: "Notes",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const first = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "notes",
          url: "/notes",
          title: "Notes",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(first.status).toBe(303);
    const base = (
      await db`SELECT id FROM cms_revisions ORDER BY created_at DESC LIMIT 1`
    )[0].id as string;

    // A deploy removes the hero block type, so the saved block is flagged and
    // the client can no longer serialize it.
    await db`UPDATE cms_block_types SET removed_at = NOW() WHERE name = 'hero'`;

    // The Remove control sends the block's base index; the block must not be
    // carried back into the new revision.
    const removed = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "notes",
          url: "/notes",
          title: "Notes",
          content: JSON.stringify({ blocks: [] }),
          base_revision: base,
          removed_blocks: "0",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(removed.status).toBe(303);

    const latest = await db`
      SELECT content FROM cms_revisions ORDER BY created_at DESC LIMIT 1
    `;
    expect(latest[0].content.blocks).toEqual([]);

    // The removal only affects the new revision: the block's data is still in
    // the revision it was saved in.
    const oldest = await db`
      SELECT content FROM cms_revisions ORDER BY created_at ASC, id ASC LIMIT 1
    `;
    expect(oldest[0].content.blocks).toHaveLength(1);
    expect(oldest[0].content.blocks[0].type).toBe("hero");

    const published = await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    expect(published.status).toBe(303);
    expect((await getPageById(pageId))?.publishedRevisionId).not.toBeNull();
  });

  test("the delete confirm step names the page, its redirects and its linkers", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    await db`
      INSERT INTO cms_redirects (id, from_path, to_page_id)
      VALUES (${randomUUID()}, '/old-about', ${pageId})
    `;

    const other = await createPage({
      pageType: "landing",
      url: "/other",
      title: "Other",
    });
    if (!other.ok) throw new Error("create failed");
    await savePageDraft({
      pageId: other.page.id,
      content: {
        blocks: [
          {
            type: "hero",
            heading: "Go",
            body: document,
            cta: { type: "page", pageId },
          },
        ],
      },
      baseRevisionId: null,
      actorId: editorId,
    });

    const res = await pages.confirmDelete(
      createBunRequest(
        `${ORIGIN}/cms/pages/${pageId}/delete`,
        {
          method: "GET",
          headers: { cookie: `cms_session=${sessionId}` },
        },
        { id: pageId },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<code>/about</code>");
    expect(html).toContain("<strong>1</strong> redirect points");
    expect(html).toContain("<strong>1</strong> page links");
    expect(html).toContain("Other");
    expect(html).toContain("<code>/other</code>");
    // It confirms rather than blocks: the button posts to the delete route.
    expect(html).toContain(`action="/cms/pages/${pageId}/delete"`);
  });

  test("the confirm step's button deletes the page", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.destroy(
      await post(
        `/cms/pages/${pageId}/delete`,
        {},
        `/cms/pages/${pageId}/delete`,
        { id: pageId },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cms/pages?deleted=1");
    expect(await getPageById(pageId)).toBeNull();
  });

  describe("CSRF on every POST route", () => {
    let pageId: string;

    beforeEach(async () => {
      const created = await createPage({
        pageType: "landing",
        url: "/about",
        title: "About us",
      });
      if (!created.ok) throw new Error("create failed");
      pageId = created.page.id;
    });

    test("refuses creating a page with a token minted for another path", async () => {
      const res = await pages.create(
        await post(
          "/cms/pages/new",
          { pageType: "landing", url: "/new", title: "New" },
          `/cms/pages/${pageId}`,
          {},
        ),
      );

      expect(res.status).toBe(403);
      expect(await getPageByUrl("/new")).toBeNull();
    });

    test("refuses a save with a token minted for another path", async () => {
      const res = await pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url: "/about",
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: "",
          },
          `/cms/pages/${pageId}/publish`,
          { id: pageId },
        ),
      );

      expect(res.status).toBe(403);
      expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
    });

    test("refuses a publish with a token minted for another path", async () => {
      const res = await pagePublish.publish(
        await post(
          `/cms/pages/${pageId}/publish`,
          { revision: "" },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );

      expect(res.status).toBe(403);
      expect((await getPageById(pageId))?.publishedRevisionId).toBeNull();
    });

    test("refuses a restore with a token minted for another path", async () => {
      const res = await pagePublish.restore(
        await post(
          `/cms/pages/${pageId}/restore`,
          { revision: "00000000-0000-0000-0000-000000000000" },
          `/cms/pages/${pageId}/publish`,
          { id: pageId },
        ),
      );

      expect(res.status).toBe(403);
    });

    test("refuses a delete with a token minted for another path", async () => {
      const res = await pages.destroy(
        await post(`/cms/pages/${pageId}/delete`, {}, `/cms/pages/${pageId}`, {
          id: pageId,
        }),
      );

      expect(res.status).toBe(403);
      expect(await getPageById(pageId)).not.toBeNull();
    });
  });
});
