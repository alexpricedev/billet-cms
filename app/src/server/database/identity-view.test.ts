import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  createPasswordSiteTables,
  createSiteTables,
  createTempDatabase,
  relationNames,
} from "../test-utils/migration-helpers";
import { ensureIdentitiesView } from "./identity-view";
import { runMigrations } from "./migrate";

const viewDefinition = async (sql: SQL): Promise<string> => {
  const rows = await sql`
    SELECT pg_get_viewdef('cms_identities'::regclass, true) AS definition
  `;
  return (rows[0] as { definition: string }).definition;
};

describe("cms_identities view", () => {
  test("is created from the site's admins when it is missing", async () => {
    const temp = await createTempDatabase("identity-create");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).toContain("cms_identities");

      const definition = await viewDefinition(sql);
      expect(definition).toContain("users");
      expect(definition).toContain("admin");
    } finally {
      await temp.drop();
    }
  });

  // Password mode is the same `users` table with the credential columns on it.
  // The default view still reads only the identity columns, which is what lets
  // the CMS sign a password-mode site's admins in without ever reaching the
  // hash the site stores there.
  test("reads a password-mode users table without exposing the credential", async () => {
    const temp = await createTempDatabase("identity-password-mode");

    try {
      const sql = temp.open();
      await createPasswordSiteTables(sql);
      await runMigrations(sql);
      await sql`
        INSERT INTO users (email, role, password_hash, email_verified_at)
        VALUES
          ('admin@example.com', 'admin', 'argon2id$test$hash', CURRENT_TIMESTAMP),
          ('member@example.com', 'user', 'argon2id$test$hash', CURRENT_TIMESTAMP)
      `;

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).toContain("cms_identities");
      const rows = await sql`
        SELECT email, role FROM cms_identities ORDER BY email
      `;
      expect(rows).toEqual([{ email: "admin@example.com", role: "admin" }]);

      // The view carries the identity columns and nothing else, so the password
      // hash is not reachable through the one relation the CMS reads the site's
      // accounts through.
      const columns = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'cms_identities'
        ORDER BY column_name
      `;
      expect(
        (columns as { column_name: string }[]).map((c) => c.column_name),
      ).toEqual(["email", "id", "role"]);
    } finally {
      await temp.drop();
    }
  });

  // The rule the whole view exists for: the site owns its definition. A
  // CREATE OR REPLACE on every boot would quietly undo a site's editor roles.
  test("is left alone once a site has customised it", async () => {
    const temp = await createTempDatabase("identity-custom");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);
      await ensureIdentitiesView(sql);

      const defaultDefinition = await viewDefinition(sql);

      await sql`
        CREATE OR REPLACE VIEW cms_identities AS
        SELECT id, email, role FROM users
        WHERE role = ANY (ARRAY['admin', 'editor'])
      `;
      const customised = await viewDefinition(sql);
      expect(customised).not.toBe(defaultDefinition);

      await ensureIdentitiesView(sql);

      expect(await viewDefinition(sql)).toBe(customised);
    } finally {
      await temp.drop();
    }
  });

  // The documented way a site changes a pinned column: Postgres refuses to drop
  // or retype `users.id`, `users.email` or `users.role` while the view depends
  // on it, so the site's migration drops the view first. That drop is the whole
  // signal — the next boot finds no view and rebuilds the default.
  test("is rebuilt after a site drops it to retype a column", async () => {
    const temp = await createTempDatabase("identity-rebuild");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);
      await ensureIdentitiesView(sql);
      const defaultDefinition = await viewDefinition(sql);
      await sql`
        INSERT INTO users (email, role)
        VALUES ('admin@example.com', 'admin'), ('user@example.com', 'user')
      `;

      await sql`DROP VIEW cms_identities`;
      await sql`ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(30)`;

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).toContain("cms_identities");
      expect(await viewDefinition(sql)).toBe(defaultDefinition);
      const rows = await sql`
        SELECT email FROM cms_identities ORDER BY email
      `;
      expect(rows).toEqual([{ email: "admin@example.com" }]);
    } finally {
      await temp.drop();
    }
  });

  test("is skipped while the site's users table does not exist", async () => {
    const temp = await createTempDatabase("identity-skip");

    try {
      const sql = temp.open();
      await runMigrations(sql);

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).not.toContain("cms_identities");
    } finally {
      await temp.drop();
    }
  });

  // The existence check is scoped to `current_schema()`, the schema the CMS
  // would create in, not to whatever a same-named relation the session's
  // `search_path` reaches happens to be. A single connection is used because
  // `SET search_path` is session state and `open()`'s pool would otherwise hand
  // the next query a different one.
  test("creates in the current schema despite a same-named relation elsewhere", async () => {
    const temp = await createTempDatabase("identity-schema");
    const sql = temp.openOne();

    try {
      await createSiteTables(sql);
      await runMigrations(sql);
      await sql.unsafe("CREATE SCHEMA shadow");
      await sql.unsafe("CREATE TABLE shadow.cms_identities (id integer)");
      await sql.unsafe("SET search_path TO public, shadow");

      await ensureIdentitiesView(sql);

      const rows = await sql`
        SELECT n.nspname AS schema, c.relkind AS kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'cms_identities'
        ORDER BY n.nspname
      `;
      expect(rows).toEqual([
        { schema: "public", kind: "v" },
        { schema: "shadow", kind: "r" },
      ]);
    } finally {
      await sql.end();
      await temp.drop();
    }
  });

  // The documented setup order is CMS first, then the site. The first boot has
  // no users table to build a view over, so it skips; the next boot, after the
  // site's deploy, is where the view appears.
  test("appears on a later boot once the site's tables exist", async () => {
    const temp = await createTempDatabase("identity-late");

    try {
      const sql = temp.open();

      await runMigrations(sql);
      await ensureIdentitiesView(sql);
      expect(await relationNames(sql)).not.toContain("cms_identities");

      await createSiteTables(sql);
      await sql`
        INSERT INTO users (email, role)
        VALUES ('admin@example.com', 'admin'), ('user@example.com', 'user')
      `;

      await ensureIdentitiesView(sql);

      expect(await relationNames(sql)).toContain("cms_identities");
      // The default exposes the site's admins and nothing else.
      const rows = await sql`
        SELECT email, role FROM cms_identities ORDER BY email
      `;
      expect(rows).toEqual([{ email: "admin@example.com", role: "admin" }]);
    } finally {
      await temp.drop();
    }
  });
});
