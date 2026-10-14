import { afterEach, describe, expect, test } from "bun:test";
import { PullRefusedError, pullFrom } from "@alexpricedev/billet-cms/cli/pull";
import {
  type CmsExport,
  CONTRACT_VERSION,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
} from "@alexpricedev/billet-cms/contract";
import { createTempDatabase } from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";

/**
 * `cms:pull` against a real database and a stand-in CMS.
 *
 * The stand-in is a `Bun.serve` that answers `GET /export` with a fixed
 * document, so the test proves the two things the pull owns: it replaces local
 * content with what came back (not merges, not appends) and it refuses the two
 * conditions where running would be wrong — production, and a bad token.
 */
const document: CmsExport = {
  format: EXPORT_FORMAT,
  version: EXPORT_FORMAT_VERSION,
  contractVersion: CONTRACT_VERSION,
  contentVersion: 9,
  exportedAt: "2026-10-14T00:00:00.000Z",
  pages: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      pageType: "landing",
      url: "/pulled",
      title: "Pulled page",
      seoDescription: null,
      socialImage: null,
      publishedRevisionId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
  ],
  slots: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "home.hero",
      blockName: "hero",
      page: "home",
      previewPath: "/",
      label: null,
      help: null,
      publishedRevisionId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
  ],
  revisions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      targetType: "page",
      targetId: "11111111-1111-4111-8111-111111111111",
      content: { blocks: [{ type: "hero", heading: "From production" }] },
      createdBy: null,
      createdAt: "2026-10-02T00:00:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      targetType: "slot",
      targetId: "33333333-3333-4333-8333-333333333333",
      content: { heading: "Pulled hero" },
      createdBy: null,
      createdAt: "2026-10-02T00:00:00.000Z",
    },
  ],
  redirects: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      fromPath: "/pulled-old",
      toPageId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-10-02T00:00:00.000Z",
    },
  ],
  media: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      objectKey: "media/x/original.webp",
      contentType: "image/webp",
      byteSize: 1234,
      width: 1920,
      height: 1080,
      alt: "A field",
      focalX: 0.5,
      focalY: 0.5,
      variants: [
        {
          width: 960,
          height: 540,
          webpKey: "media/x/960.webp",
          webpUrl: "https://bucket.example/media/x/960.webp",
          fallbackKey: "media/x/960.jpg",
          fallbackUrl: "https://bucket.example/media/x/960.jpg",
        },
      ],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A stand-in CMS: /export requires the token and answers with `body`. */
const startCms = (body: unknown, token = "good-token"): string => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/export") {
        return new Response("Not found", { status: 404 });
      }
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json(
          { error: { code: "invalid_token" } },
          {
            status: 401,
          },
        );
      }
      return Response.json(body);
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
};

describe("cms:pull", () => {
  test("replaces local content with the export, and keeps production image URLs", async () => {
    const temp = await createTempDatabase("pull");
    try {
      const sql = temp.open();
      await runMigrations(sql);

      // Content that must be gone after the pull: a page, a slot and a media row
      // the export does not mention.
      await sql`
        INSERT INTO cms_pages (page_type, url, title)
        VALUES ('landing', '/local-only', 'Local only')
      `;
      await sql`
        INSERT INTO cms_media (object_key, content_type, byte_size, width,
          height, alt, variants)
        VALUES ('local/original.webp', 'image/webp', 10, 10, 10, 'Local',
          '[]'::jsonb)
      `;
      const before = (await sql`
        SELECT content_version FROM cms_meta WHERE id = 1
      `) as { content_version: number }[];

      const from = startCms(document);
      const summary = await pullFrom({
        from,
        token: "good-token",
        sql,
        fetchImpl: Bun.fetch,
      });

      expect(summary).toEqual({
        pages: 1,
        slots: 1,
        revisions: 2,
        redirects: 1,
        media: 1,
        contentVersion: Number(before[0].content_version) + 1,
      });

      // The local-only rows are gone; the pulled ones are present. A pull
      // replaces, it does not merge.
      const pages = (await sql`SELECT url FROM cms_pages`) as {
        url: string;
      }[];
      expect(pages.map((page) => page.url)).toEqual(["/pulled"]);

      const slots = (await sql`SELECT name FROM cms_slots`) as {
        name: string;
      }[];
      expect(slots.map((slot) => slot.name)).toEqual(["home.hero"]);

      // Images keep pointing at the production bucket.
      const media = (await sql`SELECT variants FROM cms_media`) as {
        variants: { fallbackUrl: string }[];
      }[];
      expect(media).toHaveLength(1);
      expect(media[0].variants[0].fallbackUrl).toBe(
        "https://bucket.example/media/x/960.jpg",
      );

      // The redirect came across.
      const redirects = (await sql`SELECT from_path FROM cms_redirects`) as {
        from_path: string;
      }[];
      expect(redirects.map((redirect) => redirect.from_path)).toEqual([
        "/pulled-old",
      ]);
    } finally {
      await temp.drop();
    }
  });

  test("refuses to run under NODE_ENV=production", async () => {
    const temp = await createTempDatabase("pull-prod");
    try {
      const sql = temp.open();
      await runMigrations(sql);

      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await expect(
          pullFrom({ from: "https://cms.example.com", token: "x", sql }),
        ).rejects.toBeInstanceOf(PullRefusedError);
      } finally {
        process.env.NODE_ENV = previous;
      }
    } finally {
      await temp.drop();
    }
  });

  test("reports a refused token rather than writing", async () => {
    const temp = await createTempDatabase("pull-token");
    try {
      const sql = temp.open();
      await runMigrations(sql);

      const from = startCms(document);
      await expect(
        pullFrom({ from, token: "wrong-token", sql, fetchImpl: Bun.fetch }),
      ).rejects.toThrow(/answered 401/);
    } finally {
      await temp.drop();
    }
  });
});
