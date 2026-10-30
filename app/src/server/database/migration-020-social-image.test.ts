import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectQueryToReject } from "../test-utils/helpers";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/020_page_social_image_media";

/**
 * 020 turns a page's social image from a pasted URL into a reference to a
 * `cms_media` row: the column is replaced, the old URLs are dropped (there is
 * no way to turn an address into an upload), and the foreign key backs up the
 * CMS's own refusal to delete an upload a page uses.
 */
describe("020_page_social_image_media", () => {
  test("replaces the URL column on a database that has URL rows", async () => {
    const temp = await createTempDatabase("migration-020");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      // Undo the migration to get the shape a database had before it, then
      // save a page the way the old form did.
      await down(sql);
      const [before] = (await sql`
        INSERT INTO cms_pages (page_type, url, title, social_image)
        VALUES ('standard', '/about', 'About', 'https://example.com/about.jpg')
        RETURNING url, social_image
      `) as { url: string; social_image: string | null }[];
      expect(before).toEqual({
        url: "/about",
        social_image: "https://example.com/about.jpg",
      });

      await up(sql);

      // The text column is gone and the UUID column is nullable — an existing
      // page has no image rather than a broken reference.
      const columns = (await sql`
        SELECT column_name, data_type, is_nullable, udt_name
        FROM information_schema.columns
        WHERE table_name = 'cms_pages'
      `) as {
        column_name: string;
        data_type: string;
        is_nullable: string;
        udt_name: string;
      }[];
      const byName = new Map(
        columns.map((column) => [column.column_name, column]),
      );
      expect(byName.has("social_image")).toBe(false);
      expect(byName.get("social_image_id")).toEqual({
        column_name: "social_image_id",
        data_type: "uuid",
        is_nullable: "YES",
        udt_name: "uuid",
      });

      // The row and its other settings survive; the pasted URL has no
      // replacement.
      const [after] = (await sql`
        SELECT url, title, social_image_id
        FROM cms_pages
        WHERE url = '/about'
      `) as { url: string; title: string; social_image_id: string | null }[];
      expect(after).toEqual({
        url: "/about",
        title: "About",
        social_image_id: null,
      });
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("the reference is a cms_-prefixed foreign key, and it is indexed", async () => {
    const temp = await createTempDatabase("migration-020-fk");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const constraints = (await sql`
        SELECT conname, contype
        FROM pg_constraint
        WHERE conrelid = 'cms_pages'::regclass
          AND conname LIKE '%social_image%'
      `) as { conname: string; contype: string }[];
      expect(constraints).toEqual([
        { conname: "cms_pages_social_image_id_fkey", contype: "f" },
      ]);

      // The delete-protection lookup ("which pages use this upload?") is not
      // served by the page's own key, so the migration indexes it.
      const indexes = (await sql`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'cms_pages'
          AND indexname LIKE '%social_image%'
      `) as { indexname: string }[];
      expect(indexes.map((row) => row.indexname)).toEqual([
        "cms_pages_social_image_id_idx",
      ]);
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("accepts an upload id, refuses an unknown one and blocks deleting a used upload", async () => {
    const temp = await createTempDatabase("migration-020-refs");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const [upload] = (await sql`
        INSERT INTO cms_media
          (object_key, content_type, byte_size, width, height, alt, variants)
        VALUES
          ('founder.webp', 'image/webp', 1024, 1600, 900, 'The founder', '[]'::jsonb)
        RETURNING id
      `) as { id: string }[];

      const [page] = (await sql`
        INSERT INTO cms_pages (page_type, url, title, social_image_id)
        VALUES ('standard', '/about', 'About', ${upload.id})
        RETURNING social_image_id
      `) as { social_image_id: string | null }[];
      expect(page.social_image_id).toBe(upload.id);

      // An id that names no upload is refused by the database, not only by the
      // save path.
      await expectQueryToReject(
        () => sql`
          UPDATE cms_pages
          SET social_image_id = ${randomUUID()}
          WHERE url = '/about'
        `,
        /cms_pages_social_image_id_fkey/,
      );

      // The foreign key is the backstop when the CMS's usage check misses: a
      // used upload cannot be deleted.
      await expectQueryToReject(
        () => sql`DELETE FROM cms_media WHERE id = ${upload.id}`,
        /cms_pages_social_image_id_fkey/,
      );
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("down restores the text column and up applies again", async () => {
    const temp = await createTempDatabase("migration-020-down");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await down(sql);

      const columns = (await sql`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'cms_pages'
          AND column_name IN ('social_image', 'social_image_id')
      `) as { column_name: string; data_type: string }[];
      expect(columns).toEqual([
        { column_name: "social_image", data_type: "text" },
      ]);

      // The restored column takes a pasted URL again.
      const [page] = (await sql`
        INSERT INTO cms_pages (page_type, url, title, social_image)
        VALUES ('standard', '/studio', 'Studio', '/legacy.jpg')
        RETURNING social_image
      `) as { social_image: string | null }[];
      expect(page.social_image).toBe("/legacy.jpg");

      await up(sql);
      const back = (await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'cms_pages'
          AND column_name IN ('social_image', 'social_image_id')
      `) as { column_name: string }[];
      expect(back.map((row) => row.column_name)).toEqual(["social_image_id"]);
    } finally {
      await temp.drop();
    }
  }, 60000);
});
