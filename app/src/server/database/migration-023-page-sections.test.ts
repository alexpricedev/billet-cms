import { describe, expect, test } from "bun:test";
import { expectQueryToReject } from "../test-utils/helpers";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/023_add_page_sections";

/**
 * 023 creates `cms_page_sections`, the table a deploy's `sections` publish
 * writes and the Pages list groups pages under. The column shapes are the
 * contract with the publish step: `paths` is a JSONB array read back as a
 * string array, and `position` is the config index that orders the groups.
 */
describe("023_add_page_sections", () => {
  test("stores a declared section, with its patterns, label and position", async () => {
    const temp = await createTempDatabase("migration-023");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const [inserted] = (await sql`
        INSERT INTO cms_page_sections (name, label, paths, position)
        VALUES (
          'journal',
          'Journal',
          '["/journal", "/journal/**"]'::jsonb,
          1
        )
        RETURNING id, name, label, paths, position, removed_at
      `) as {
        id: string;
        name: string;
        label: string | null;
        paths: string[];
        position: number;
        removed_at: Date | null;
      }[];

      expect(inserted.name).toBe("journal");
      expect(inserted.label).toBe("Journal");
      // The publish step compares this straight against the declaration, so it
      // has to come back as an array of strings, not a JSON string.
      expect(inserted.paths).toEqual(["/journal", "/journal/**"]);
      expect(inserted.position).toBe(1);
      expect(inserted.removed_at).toBeNull();

      // The label is optional (the Pages list falls back to the humanised
      // name), and a row is born live.
      const [unlabelled] = (await sql`
        INSERT INTO cms_page_sections (name, paths, position)
        VALUES ('case-studies', '["/case-study-*"]'::jsonb, 0)
        RETURNING label, removed_at
      `) as { label: string | null; removed_at: Date | null }[];
      expect(unlabelled).toEqual({ label: null, removed_at: null });
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("every column has the type the publish step writes", async () => {
    const temp = await createTempDatabase("migration-023-columns");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const columns = (await sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'cms_page_sections'
        ORDER BY ordinal_position
      `) as {
        column_name: string;
        data_type: string;
        is_nullable: string;
      }[];

      expect(
        columns.map(({ column_name, data_type, is_nullable }) => [
          column_name,
          data_type,
          is_nullable,
        ]),
      ).toEqual([
        ["id", "uuid", "NO"],
        ["name", "character varying", "NO"],
        ["label", "text", "YES"],
        ["paths", "jsonb", "NO"],
        ["position", "integer", "NO"],
        ["removed_at", "timestamp with time zone", "YES"],
        ["created_at", "timestamp with time zone", "NO"],
        ["updated_at", "timestamp with time zone", "NO"],
      ]);

      await sql`
        INSERT INTO cms_page_sections (name, paths, position)
        VALUES ('journal', '["/journal"]'::jsonb, 0)
      `;

      // The database refuses what the publish step must never write: a section
      // with no patterns, and two rows with one name (a redeclare updates the
      // existing row, it does not insert a second).
      await expectQueryToReject(
        () => sql`
          INSERT INTO cms_page_sections (name, paths, position)
          VALUES ('journal', NULL, 0)
        `,
        /null value in column "paths"/,
      );
      await expectQueryToReject(
        () => sql`
          INSERT INTO cms_page_sections (name, paths, position)
          VALUES ('journal', '["/journal"]'::jsonb, 0)
        `,
        /cms_page_sections_name_key/,
      );
      await expectQueryToReject(
        () => sql`
          INSERT INTO cms_page_sections (name, paths, position)
          VALUES ('journal', '["/journal"]'::jsonb, NULL)
        `,
        /null value in column "position"/,
      );
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("every relation and constraint it creates is cms_-prefixed and indexed", async () => {
    const temp = await createTempDatabase("migration-023-names");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      // The table, its two constraints' indexes and the removed_at index. An
      // unprefixed name here would collide with the site's own schema.
      const relations = (await sql`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname LIKE 'cms\\_page\\_sections%'
        ORDER BY c.relname
      `) as { relname: string }[];
      expect(relations.map((row) => row.relname)).toEqual([
        "cms_page_sections",
        "cms_page_sections_name_key",
        "cms_page_sections_pkey",
        "cms_page_sections_removed_at_idx",
      ]);

      const constraints = (await sql`
        SELECT conname, contype
        FROM pg_constraint
        WHERE conrelid = 'cms_page_sections'::regclass
        ORDER BY conname
      `) as { conname: string; contype: string }[];
      expect(constraints).toEqual([
        { conname: "cms_page_sections_name_key", contype: "u" },
        { conname: "cms_page_sections_pkey", contype: "p" },
      ]);

      const index = (await sql`
        SELECT indexdef
        FROM pg_indexes
        WHERE tablename = 'cms_page_sections'
          AND indexname = 'cms_page_sections_removed_at_idx'
      `) as { indexdef: string }[];
      expect(index[0]?.indexdef).toContain("(removed_at)");
    } finally {
      await temp.drop();
    }
  }, 60000);

  test("down drops the table and up recreates it empty", async () => {
    const temp = await createTempDatabase("migration-023-down");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await sql`
        INSERT INTO cms_page_sections (name, paths, position)
        VALUES ('journal', '["/journal"]'::jsonb, 0)
      `;

      await down(sql);
      const gone =
        await sql`SELECT to_regclass('cms_page_sections') AS relation`;
      expect(gone[0].relation).toBeNull();

      await up(sql);
      const back =
        await sql`SELECT to_regclass('cms_page_sections') AS relation`;
      expect(back[0].relation).not.toBeNull();

      // A fresh table, not a restored one: `cms_page_sections` is a published
      // declaration, so the next publish re-inserts it.
      const rows = (await sql`SELECT name FROM cms_page_sections`) as {
        name: string;
      }[];
      expect(rows).toEqual([]);
    } finally {
      await temp.drop();
    }
  }, 60000);
});
