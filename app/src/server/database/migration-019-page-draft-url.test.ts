import { describe, expect, test } from "bun:test";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/019_add_page_draft_url";

/**
 * 019 adds `cms_pages.draft_url`: a page's new address waits there until
 * Publish, so saving a draft no longer moves the live URL.
 */
describe("019_add_page_draft_url", () => {
  test("adds a nullable column and keeps every page's live URL", async () => {
    const temp = await createTempDatabase("migration-019");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      // A page that existed before the migration keeps its live address and
      // has no pending one.
      const [page] = (await sql`
        INSERT INTO cms_pages (page_type, url, title)
        VALUES ('standard', '/about', 'About')
        RETURNING url, draft_url
      `) as { url: string; draft_url: string | null }[];
      expect(page).toEqual({ url: "/about", draft_url: null });

      // Storing a draft address leaves `url` — the live address — alone.
      const [drafted] = (await sql`
        UPDATE cms_pages SET draft_url = '/studio'
        WHERE url = '/about'
        RETURNING url, draft_url
      `) as { url: string; draft_url: string | null }[];
      expect(drafted).toEqual({ url: "/about", draft_url: "/studio" });

      // The column is the only thing the migration adds; it is not indexed.
      const indexes = (await sql`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'cms_pages'
          AND indexdef LIKE '%draft_url%'
      `) as { indexname: string }[];
      expect(indexes).toEqual([]);
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("down drops the column and up restores it empty", async () => {
    const temp = await createTempDatabase("migration-019-down");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await sql`
        INSERT INTO cms_pages (page_type, url, title, draft_url)
        VALUES ('standard', '/about', 'About', '/studio')
      `;

      await down(sql);
      const columns = (await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'cms_pages' AND column_name = 'draft_url'
      `) as { column_name: string }[];
      expect(columns).toEqual([]);

      await up(sql);
      const [page] = (await sql`
        SELECT url, draft_url FROM cms_pages WHERE url = '/about'
      `) as { url: string; draft_url: string | null }[];
      expect(page).toEqual({ url: "/about", draft_url: null });
    } finally {
      await temp.drop();
    }
  }, 60000);
});
