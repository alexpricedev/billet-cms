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
  getPageByUrl,
  listRedirects,
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

  test("saves content and writes a redirect when the URL changes", async () => {
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
          url: "/about",
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
    expect(await db`SELECT id FROM cms_revisions`).toHaveLength(1);

    const renamed = await pages.save(
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
    // The base revision is stale (a second save), so this re-renders with a
    // conflict rather than saving — but the settings half already renamed it
    // and wrote the 301.
    expect([200, 303]).toContain(renamed.status);
    expect(await getPageByUrl("/about-us")).not.toBeNull();
    const redirects = await listRedirects();
    expect(redirects.map((redirect) => redirect.fromPath)).toContain("/about");
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
});
