import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  block,
  type PageTypeDefinition,
  pageType,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import { createBunRequest } from "../../test-utils/bun-request";
import { seedBlockType, seedPageType } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";

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
  savePageDraft,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import { createAuthenticatedSession } from "../../services/sessions";
import { pagePublish } from "./page-publish";
import { pages } from "./pages";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  { heading: text({ max: 80, label: "Heading" }), body: richText() },
  () => null,
);

const landing: PageTypeDefinition = pageType("landing", {
  allowedBlocks: [hero],
  requiredBlocks: [hero],
  limits: { hero: { max: 1, position: "top" } },
});

const document = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
};

const pageContent = (heading: string) => ({
  blocks: [{ type: "hero", heading, body: document }],
});

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
