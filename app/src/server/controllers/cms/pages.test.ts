import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  block,
  group,
  image,
  link,
  MAX_RICH_TEXT_LIST_DEPTH,
  type PageTypeDefinition,
  pageType,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { createMemoryStorage } from "@alexpricedev/billet-storage";
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
  getLatestRevision,
  getPageById,
  getPageByUrl,
  listRedirects,
  type PageBlock,
  publishPage,
  restorePageRevision,
  savePageDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createMedia, listMediaOptions } from "../../services/media";
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
const quote = block("quote", { body: richText() }, () => null);

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

  // Part 9: the form names the page that already has the URL rather than
  // saying "another page".
  test("says which page has a taken URL", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About Northwind",
    });
    if (!created.ok) throw new Error("create failed");

    const res = await pages.create(
      await post(
        "/cms/pages/new",
        { pageType: "landing", url: "about", title: "Team" },
        "/cms/pages/new",
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About Northwind already uses /about.");
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
    // The empty state is rendered and visible: the client toggles it with the
    // list, so the hook is always there and only the attribute changes.
    expect(html).toMatch(
      /<p[^>]*data-cms-blocks-empty(="true")?[^>]*>This page has no blocks yet/,
    );
    // The link picker's page list is threaded through to the controls.
    expect(html).toContain("data-cms-content");
  });

  test("the empty-state line is hidden once the page has a block", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const saved = await savePageDraft({
      pageId: created.page.id,
      content: pageContent("Hi"),
      baseRevisionId: null,
      actorId: editorId,
    });
    if (!saved.ok) throw new Error("save failed");

    const res = await pages.form(
      createBunRequest(
        `${ORIGIN}/cms/pages/${created.page.id}`,
        { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
        { id: created.page.id },
      ),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(
      /<p[^>]*data-cms-blocks-empty(="true")?[^>]*hidden[^>]*>This page has no blocks yet/,
    );
  });

  describe("Add buttons and the page type's limits", () => {
    const article: PageTypeDefinition = pageType("article", {
      allowedBlocks: [prose, quote, photos],
    });
    const capped: PageTypeDefinition = pageType("capped", {
      allowedBlocks: [prose],
      limits: { prose: { max: 2 } },
    });

    const formHtml = async (id: string): Promise<string> => {
      const res = await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${id}`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id },
        ),
      );
      expect(res.status).toBe(200);
      return res.text();
    };

    /** The opening tag of the Add button for a block type. */
    const addButton = (html: string, name: string): string =>
      html.match(
        new RegExp(`<button[^>]*data-block-add="${name}"[^>]*>`),
      )?.[0] ?? "";

    const withBlocks = async (
      type: string,
      blocks: PageBlock[],
    ): Promise<string> => {
      const created = await createPage({
        pageType: type,
        url: `/${type}`,
        title: type,
      });
      if (!created.ok) throw new Error("create failed");
      const saved = await savePageDraft({
        pageId: created.page.id,
        content: { blocks },
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");
      return formHtml(created.page.id);
    };

    test("a Landing page without a hero offers Add hero", async () => {
      const created = await createPage({
        pageType: "landing",
        url: "/l",
        title: "L",
      });
      if (!created.ok) throw new Error("create failed");
      const html = await formHtml(created.page.id);
      expect(addButton(html, "hero")).not.toContain("aria-disabled");
      expect(html).toContain('data-block-max="1"');
    });

    test("a Landing page with a hero greys Add hero and says why", async () => {
      const html = await withBlocks("landing", pageContent("Hi").blocks);
      expect(addButton(html, "hero")).toContain('aria-disabled="true"');
      expect(addButton(html, "hero")).toContain(
        'aria-describedby="block-add-limit-hero"',
      );
      expect(html).toMatch(
        /<span[^>]*id="block-add-limit-hero"(?![^>]*hidden)[^>]*>Add hero is off: only one hero per page/,
      );
    });

    test("an Article page offers only its blocks, all enabled", async () => {
      await seedBlockType(db, prose);
      await seedBlockType(db, quote);
      await seedBlockType(db, photos);
      await seedPageType(db, article);
      const html = await withBlocks("article", [
        { type: "prose", body: document },
      ]);
      expect(html).not.toContain('data-block-add="hero"');
      expect(html).not.toContain('data-block-add="cta"');
      for (const name of ["prose", "quote", "photos"]) {
        expect(addButton(html, name)).toContain(`data-block-add="${name}"`);
        expect(addButton(html, name)).not.toContain("aria-disabled");
      }
    });

    test("a max above one says how many", async () => {
      await seedBlockType(db, prose);
      await seedPageType(db, capped);
      const one = await withBlocks("capped", [
        { type: "prose", body: document },
      ]);
      expect(addButton(one, "prose")).not.toContain("aria-disabled");
      expect(one).toContain("Add prose is off: only 2 prose blocks per page");
    });

    test("a max of two greys the button at two blocks", async () => {
      await seedBlockType(db, prose);
      await seedPageType(db, capped);
      const two = await withBlocks("capped", [
        { type: "prose", body: document },
        { type: "prose", body: document },
      ]);
      expect(addButton(two, "prose")).toContain('aria-disabled="true"');
    });
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

  // Parts 1-3 on the page editor: the same bar, the same two-sided status.
  describe("action bar", () => {
    const statusOf = (html: string): string =>
      html.match(/class="cms-publish-status"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";

    const publishButton = (html: string): string =>
      html.match(
        /<button[^>]*class="[^"]*cms-publish-button[^"]*"[^>]*>/,
      )?.[0] ?? "";

    const saveButton = (html: string): string =>
      html.match(/<button[^>]*class="[^"]*cms-save[^"]*"[^>]*>/)?.[0] ?? "";

    const formHtml = async (pageId: string): Promise<string> =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();

    const create = async (): Promise<string> => {
      const created = await createPage({
        pageType: "landing",
        url: "/about",
        title: "About us",
      });
      if (!created.ok) throw new Error("create failed");
      return created.page.id;
    };

    test("says no draft is saved and why both buttons are off", async () => {
      const pageId = await create();
      const html = await formHtml(pageId);

      expect(statusOf(html)).toBe("No draft saved yet.");
      expect(html).toContain("Nothing to publish: no draft saved yet.");
      expect(html).toContain("No draft to preview.");
      expect(publishButton(html)).toContain("disabled");
      expect(publishButton(html)).toContain("btn-secondary");
      expect(saveButton(html)).toContain("btn-primary");
    });

    test("says what the saved draft is when nothing is live", async () => {
      const pageId = await create();
      const saved = await savePageDraft({
        pageId,
        content: pageContent("About us"),
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");

      const html = await formHtml(pageId);

      expect(statusOf(html)).toMatch(
        /^Not published yet\. Draft saved \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\.$/,
      );
      expect(publishButton(html)).toContain("btn-primary");
      expect(publishButton(html)).not.toContain("disabled");
      expect(saveButton(html)).toContain("btn-secondary");
    });

    test("says what is live once the draft is published", async () => {
      const pageId = await create();
      const saved = await savePageDraft({
        pageId,
        content: pageContent("About us"),
        baseRevisionId: null,
        actorId: editorId,
      });
      if (!saved.ok) throw new Error("save failed");
      await publishPage({ pageId, revisionId: saved.revision.id });

      const html = await formHtml(pageId);

      expect(statusOf(html)).toMatch(
        /^Live since \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\. No unpublished changes\.$/,
      );
      expect(html).toContain("Nothing to publish: no unpublished changes.");
      expect(html).toContain("Nothing to preview: no unpublished changes.");
      expect(publishButton(html)).toContain("disabled");
    });

    test("keeps Save draft a submit of the content form", async () => {
      const pageId = await create();
      const html = await formHtml(pageId);

      expect(saveButton(html)).toContain('form="cms-page-form"');
      expect(html).toContain('id="cms-page-form"');
    });

    // The form carries no bottom padding of its own: the clearance under its
    // last field is the sticky bar's in-flow space plus its `margin-top`. That
    // only holds while the bar stays after every field in the flow, so pin it.
    test("keeps the action bar after every field in the form", async () => {
      const pageId = await create();
      const html = await formHtml(pageId);

      const bar = html.indexOf('aria-label="Publishing"');
      expect(bar).toBeGreaterThan(-1);
      expect(html.slice(bar)).not.toContain('class="cms-field"');
    });
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
    // The block carries two field errors, so the banner says how many fields
    // want fixing and links each one to its control.
    expect(html).toContain("Fix these 2 fields and try again:");
    expect(html).toContain('href="#cms-block-0-hero-heading"');
    expect(html).toContain('href="#cms-block-0-hero-cta"');
    // Nothing was written.
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // Button text is an editor rule the page save shares with the slot save, so
  // a plain link with no words is refused here too, with the editor's message.
  test("refuses a page whose plain link has no button text", async () => {
    const plain = block("plain", { cta: link() }, () => null);
    await seedBlockType(db, plain);
    await seedPageType(db, pageType("plains", { allowedBlocks: [plain] }));

    const created = await createPage({
      pageType: "plains",
      url: "/plain",
      title: "Plain",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "plains",
          url: "/plain",
          title: "Plain",
          content: JSON.stringify({
            blocks: [
              {
                type: "plain",
                cta: { type: "url", url: "https://example.com" },
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
    expect(await res.text()).toContain("Button text is required.");
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // The two exemptions the site can declare: a link with `text: false`, and a
  // text-on link beside a text field in the same group. Both save and publish.
  test("saves and publishes a page whose links get their text elsewhere", async () => {
    const banner = block(
      "banner",
      {
        banner: group({ heading: text(), cta: link() }),
        silent: link({ text: false }),
      },
      () => null,
    );
    await seedBlockType(db, banner);
    await seedPageType(db, pageType("banners", { allowedBlocks: [banner] }));

    const created = await createPage({
      pageType: "banners",
      url: "/banner",
      title: "Banner",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const save = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "banners",
          url: "/banner",
          title: "Banner",
          content: JSON.stringify({
            blocks: [
              {
                type: "banner",
                banner: {
                  heading: "Read this",
                  cta: { type: "url", url: "https://example.com" },
                },
                silent: { type: "url", url: "https://example.com" },
              },
            ],
          }),
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
    expect((await getPageById(pageId))?.publishedRevisionId).not.toBeNull();
  });

  // The banner's "Fix these N fields" line counts real fields only: a
  // page-limit issue (`blocks`) has no control to fix, so promising fields
  // would send the editor looking for a highlight that isn't there (review
  // round 2).
  test("counts and links fields only when a block carries a field error", async () => {
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

    // A block with a bad field: the field is marked, so the banner counts it
    // and links to it.
    const withFieldError = await save({
      blocks: [{ type: "hero", heading: "x".repeat(81), body: document }],
    });
    expect(withFieldError).toContain("Couldn't save draft.");
    // A failed save is the error tone: it interrupts, and it is closable.
    expect(withFieldError).toContain(
      'class="flash" data-tone="error" role="alert"',
    );
    expect(withFieldError).toMatch(
      /class="flash-dismiss"[^>]*aria-label="Dismiss"/,
    );
    expect(withFieldError).toContain("Fix this field and try again:");
    expect(withFieldError).toContain('href="#cms-block-0-hero-heading"');

    // No hero at all: the page-limit issue has no field to fix, so the banner
    // keeps the message but drops the field count and link.
    const limitOnly = await save({ blocks: [] });
    expect(limitOnly).toContain("Couldn't save draft.");
    expect(limitOnly).not.toContain("Fix this field");
    expect(limitOnly).not.toContain("Fix these");
    expect(limitOnly).not.toContain('href="#cms-block-');

    // Nothing was written.
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // A whole-block issue (`blocks.N`, with no field path) has no control to mark,
  // so the summary names the block by position and type — otherwise a page
  // with several blocks gives no clue which one the rich text message is about
  // (review round 2). The bad block is second, so a summary that always named
  // block 1 fails. It also links to that block, and the block itself carries
  // the message as an alert: at 390 the banner is several screens above it.
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
    // The banner line links to the block, and the block repeats the message.
    expect(html).toContain(
      `href="#block-2">Block 2 (hero): Rich text lists may nest at most ${MAX_RICH_TEXT_LIST_DEPTH} deep.</a>`,
    );
    expect(html).toMatch(
      /id="block-2"[\s\S]{0,600}class="cms-block-alert-message" role="alert">Rich text lists may nest/,
    );
    // The issue is whole-block, so no field is marked and the banner must not
    // promise fields to fix.
    expect(html).not.toContain("Fix these");
    expect(html).not.toContain('href="#cms-block-');
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(0);
  });

  // Part 8: the hero-first refusal is shown on the hero itself and says which
  // arrow fixes it; the banner links to the block rather than leaving the
  // editor to find it several screens below at 390.
  test("shows the hero-first refusal on the hero block", async () => {
    await seedBlockType(db, prose);
    // A type that takes both, so the hero can sit behind another block.
    await seedPageType(
      db,
      pageType("mixed", {
        allowedBlocks: [hero, prose],
        requiredBlocks: [hero],
        limits: { hero: { max: 1, position: "top" } },
      }),
    );
    const created = await createPage({
      pageType: "mixed",
      url: "/landing",
      title: "Landing",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const res = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "mixed",
          url: "/landing",
          title: "Landing",
          content: JSON.stringify({
            blocks: [
              { type: "prose", body: document },
              {
                type: "hero",
                heading: "Hi",
                body: { type: "doc", content: [] },
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
      'href="#block-2">Block 2 (hero): The hero block has to be first. Use the ↑ arrow to move it up.</a>',
    );
    expect(html).toMatch(
      /id="block-2"[\s\S]{0,600}role="alert">The hero block has to be first. Use the ↑ arrow to move it up.</,
    );
    // The prose block first is fine on its own; only the hero is flagged.
    expect(html).not.toMatch(
      /id="block-1"[\s\S]{0,200}cms-block-alert-message/,
    );
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
    // a field — so the banner must not promise fields to fix (review round 1).
    expect(html).not.toContain("Fix these");
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

  test("moves a never-published page's URL on save", async () => {
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
    // Nothing was live to wait for, so the address moves now; the banner
    // mentions no redirect because a save never applies one for a live page.
    expect(save.headers.get("location")).toBe(`/cms/pages/${pageId}?saved=1`);
    expect(await getPageByUrl("/about-us")).not.toBeNull();
    expect(await getPageByUrl("/about")).toBeNull();
    const redirects = await listRedirects();
    expect(redirects.map((redirect) => redirect.fromPath)).toContain("/about");
  });

  test("Publish asks first, and says when an old address redirects", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const saveAs = async (url: string, base: string) =>
      pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url,
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: base,
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );

    await saveAs("/about", "");
    const draftHtml = await (
      await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${pageId}`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: pageId },
        ),
      )
    ).text();
    expect(draftHtml).toContain("data-confirm-title=\"Publish 'About us'?\"");
    expect(draftHtml).toContain('data-confirm-danger="false"');
    expect(draftHtml).not.toContain("The old address");
    // Save draft is not gated.
    expect(draftHtml.match(/data-confirm=/g)).toHaveLength(1);

    const latest = await getLatestRevision("page", pageId);
    await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: latest?.id ?? "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    await saveAs("/about-us", latest?.id ?? "");

    const renamed = await (
      await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${pageId}`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: pageId },
        ),
      )
    ).text();
    expect(renamed).toContain(
      "The old address /about will redirect to /about-us.",
    );
  });

  test("a published page's URL change waits for Publish", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;

    const save = async (url: string, base: string) =>
      pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url,
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: base,
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );
    const view = async (query = "") =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}${query}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();
    const publishLatest = async () => {
      const latest = await getLatestRevision("page", pageId);
      return pagePublish.publish(
        await post(
          `/cms/pages/${pageId}/publish`,
          { revision: latest?.id ?? "" },
          `/cms/pages/${pageId}/publish`,
          { id: pageId },
        ),
      );
    };

    // Give the page a live address to move away from.
    await save("/about", "");
    const first = await getLatestRevision("page", pageId);
    expect((await publishLatest()).status).toBe(303);

    // The change is stored with the draft: nothing live moves, no redirect.
    const draft = await save("/about-us", first?.id ?? "");
    expect(draft.status).toBe(303);
    expect(draft.headers.get("location")).toBe(`/cms/pages/${pageId}?saved=1`);
    expect(await getPageByUrl("/about")).not.toBeNull();
    expect(await getPageByUrl("/about-us")).toBeNull();
    expect(await listRedirects()).toHaveLength(0);

    // The editor shows the draft address and Publish names both addresses.
    const editor = await view("?saved=1");
    expect(editor).toContain('value="/about-us"');
    expect(editor).toContain("<code>/about-us</code> (not published)");
    expect(editor).toMatch(/<p[^>]*data-url-move(?![^>]*hidden)/);
    expect(editor).toContain(
      'Publishing moves this page: <code>/about</code> will redirect to <code data-url-move-to="true">/about-us</code>.',
    );
    expect(editor).toContain(
      "The old address /about will redirect to /about-us.",
    );

    // Publish applies it and the banner names the redirect as the detail.
    const published = await publishLatest();
    expect(published.status).toBe(303);
    expect(published.headers.get("location")).toBe(
      `/cms/pages/${pageId}?published=1&moved=%2Fabout`,
    );
    expect(await getPageByUrl("/about")).toBeNull();
    expect(await getPageByUrl("/about-us")).not.toBeNull();
    expect(
      (await listRedirects()).map((redirect) => redirect.fromPath),
    ).toContain("/about");

    const banner = await view("?published=1&moved=%2Fabout");
    expect(banner).toContain('<p class="flash-title">Page published.</p>');
    expect(banner).toContain(
      '<p class="flash-detail">/about now redirects here.</p>',
    );
  });

  test("the publish dialog lists only the pending move, and a restore drops it", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const save = async (url: string, base: string) =>
      pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url,
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: base,
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );
    const view = async () =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();

    // Publish a first move, so an older redirect (/about) is already live.
    await save("/about", "");
    const first = await getLatestRevision("page", pageId);
    await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: first?.id ?? "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    await save("/about-us", first?.id ?? "");
    await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: (await getLatestRevision("page", pageId))?.id ?? "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );

    // A second move is pending; the dialog names only the live address it
    // moves away from, not the earlier /about redirect.
    const publishedRevisionId = (await getPageById(pageId))
      ?.publishedRevisionId;
    await save("/studio", publishedRevisionId ?? "");
    const pending = await view();
    expect(pending).toContain(
      "The old address /about-us will redirect to /studio.",
    );
    expect(pending).not.toContain("The old address /about will");

    // Restoring the published revision discards the pending address, so the
    // dialog stops mentioning a redirect (#60 f45).
    const restored = await restorePageRevision({
      pageId,
      revisionId: publishedRevisionId ?? "",
      actorId: editorId,
    });
    expect(restored.ok).toBe(true);
    const afterRestore = await view();
    expect(afterRestore).toContain('value="/about-us"');
    expect(afterRestore).not.toContain("The old address");
  });

  test("a restore names the pending URL change it discarded", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const save = async (url: string, base: string) =>
      pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url,
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: base,
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );

    await save("/about", "");
    const first = await getLatestRevision("page", pageId);
    const published = await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: first?.id ?? "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    expect(published.status).toBe(303);
    await save("/studio", first?.id ?? "");
    expect((await getPageById(pageId))?.draftUrl).toBe("/studio");

    const restored = await pagePublish.restore(
      await post(
        `/cms/pages/${pageId}/restore`,
        { revision: first?.id ?? "" },
        `/cms/pages/${pageId}/restore`,
        { id: pageId },
      ),
    );
    expect(restored.status).toBe(303);
    expect(restored.headers.get("location")).toBe(
      `/cms/pages/${pageId}?restored=1&dropped=%2Fstudio`,
    );

    // The notice says a queued move went with the restore, rather than
    // dropping it silently.
    const html = await (
      await pages.form(
        createBunRequest(
          `${ORIGIN}/cms/pages/${pageId}?restored=1&dropped=%2Fstudio`,
          { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
          { id: pageId },
        ),
      )
    ).text();
    expect(html).toContain("The pending URL change to /studio was discarded.");
    expect((await getPageById(pageId))?.draftUrl).toBeNull();
  });

  test("reports a URL change without claiming a redirect on save", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const view = async (query = "") =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}${query}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();

    // Unchanged URL: the line is there for the script, but hidden.
    const plain = await view();
    expect(plain).toMatch(/<p[^>]*data-url-move[^>]*hidden/);
    expect(plain).toContain('aria-describedby="url-help url-move"');
    // The help text is a neutral example, not one that reads as the old URL.
    expect(plain).toContain("The path the page is served at, e.g. /company.");
    expect(plain).not.toContain("e.g. /about.");

    // A failed save with a new URL re-renders the line visible and the
    // breadcrumb names the unsaved URL.
    const failed = await (
      await pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url: "/studio",
            title: "",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: "",
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      )
    ).text();
    expect(failed).toMatch(/<p[^>]*data-url-move(?![^>]*hidden)/);
    // Never published: the address moves on Save, so the line must not promise
    // a redirect that only a Publish would make.
    expect(failed).toContain("Saving moves this page to");
    expect(failed).not.toContain("Publishing moves this page");
    expect(failed).toContain("(unsaved: /studio)");

    const save = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/studio",
          title: "About us",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(save.headers.get("location")).toBe(`/cms/pages/${pageId}?saved=1`);
    // A save never carries the redirect sentence; only Publish does.
    expect(await view("?saved=1&moved=%2Fabout")).toContain("Draft saved.");
    expect(await view("?saved=1&moved=%2Fabout")).not.toContain(
      "now redirects here",
    );
    // A path that isn't one of this page's redirects, or isn't a path, is the
    // plain notice.
    for (const moved of [
      "%2Fnowhere",
      "%2F%2Fevil.example",
      "https%3A%2F%2Fevil.example",
    ]) {
      const html = await view(`?saved=1&moved=${moved}`);
      expect(html).toContain("Draft saved.");
      expect(html).not.toContain("now redirects here");
    }

    // This page had never been published, so its move was already live: the
    // publish applies no address change and adds no redirect sentence.
    const latest = await getLatestRevision("page", pageId);
    const published = await pagePublish.publish(
      await post(
        `/cms/pages/${pageId}/publish`,
        { revision: latest?.id ?? "" },
        `/cms/pages/${pageId}/publish`,
        { id: pageId },
      ),
    );
    expect(published.status).toBe(303);
    expect(await view("?published=1")).not.toContain("now redirects here");
  });

  test("says how many empty blocks the save removed", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const view = async (query = "") =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}${query}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();
    const saveWith = async (dropped: string) => {
      const latest = await getLatestRevision("page", pageId);
      return pages.save(
        await post(
          `/cms/pages/${pageId}`,
          {
            pageType: "landing",
            url: "/about",
            title: "About us",
            content: JSON.stringify(pageContent("Hello")),
            base_revision: latest?.id ?? "",
            dropped_blocks: dropped,
          },
          `/cms/pages/${pageId}`,
          { id: pageId },
        ),
      );
    };

    // None removed: the redirect and the banner are what they always were.
    expect((await saveWith("")).headers.get("location")).toBe(
      `/cms/pages/${pageId}?saved=1`,
    );
    const plain = await view("?saved=1");
    expect(plain).toContain("Draft saved.");
    // The saved notice is the success banner: announced politely, and its ×
    // ships hidden so the banner is not closable without the client script.
    expect(plain).toContain('class="flash" data-tone="success" role="status"');
    expect(plain).toMatch(/class="flash-dismiss"[^>]*aria-label="Dismiss"/);
    expect(plain).toMatch(/data-flash-dismiss[^>]*hidden/);
    // The page always renders its "no blocks yet" line (the client toggles it),
    // so the assertion is on the banner's own sentence, not the word "empty".
    expect(plain).not.toContain("was removed");
    expect(plain).not.toContain("were removed");

    // One removed names its type.
    const one = await saveWith("hero");
    expect(one.headers.get("location")).toBe(
      `/cms/pages/${pageId}?saved=1&dropped=hero`,
    );
    const oneHtml = await view("?saved=1&dropped=hero");
    expect(oneHtml).toContain('<p class="flash-title">Draft saved.</p>');
    expect(oneHtml).toContain(
      '<p class="flash-detail">1 empty hero block was removed.</p>',
    );

    // Several of one type name it; several of mixed types count blocks.
    expect(await view("?saved=1&dropped=text%2Ctext")).toContain(
      '<p class="flash-detail">2 empty text blocks were removed.</p>',
    );
    expect(await view("?saved=1&dropped=hero%2Ctext%2Ctext")).toContain(
      '<p class="flash-detail">3 empty blocks were removed.</p>',
    );
    expect((await saveWith("hero,text")).headers.get("location")).toBe(
      `/cms/pages/${pageId}?saved=1&dropped=hero%2Ctext`,
    );

    // Junk entries are ignored, and a value with none valid is the plain banner.
    const junk = await view("?saved=1&dropped=%3Cb%3E%2Chero%20x%2C");
    expect(junk).toContain("Draft saved.");
    expect(junk).not.toContain("was removed");
    expect(junk).not.toContain("were removed");
    expect((await saveWith("<b>")).headers.get("location")).toBe(
      `/cms/pages/${pageId}?saved=1`,
    );
    // The sentence only follows a save.
    expect(await view("?published=1&dropped=hero")).not.toMatch(
      /empty (hero|text)? ?blocks? (was|were) removed/,
    );
  });

  test("the removed-blocks line is the save banner's detail", async () => {
    const created = await createPage({
      pageType: "landing",
      url: "/about",
      title: "About us",
    });
    if (!created.ok) throw new Error("create failed");
    const pageId = created.page.id;
    const view = async (query = "") =>
      (
        await pages.form(
          createBunRequest(
            `${ORIGIN}/cms/pages/${pageId}${query}`,
            { method: "GET", headers: { cookie: `cms_session=${sessionId}` } },
            { id: pageId },
          ),
        )
      ).text();
    const save = await pages.save(
      await post(
        `/cms/pages/${pageId}`,
        {
          pageType: "landing",
          url: "/studio",
          title: "About us",
          content: JSON.stringify(pageContent("Hello")),
          base_revision: "",
          dropped_blocks: "hero,hero",
        },
        `/cms/pages/${pageId}`,
        { id: pageId },
      ),
    );
    expect(save.headers.get("location")).toBe(
      `/cms/pages/${pageId}?saved=1&dropped=hero%2Chero`,
    );
    const html = await view("?saved=1&dropped=hero%2Chero");
    expect(html).toContain('<p class="flash-title">Draft saved.</p>');
    expect(html).toContain(
      '<p class="flash-detail">2 empty hero blocks were removed.</p>',
    );
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
            cta: { type: "page", pageId, label: "Go" },
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
