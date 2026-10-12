import { SQL } from "bun";
import { databaseName, quoteIdent, withDatabase } from "./worker-database";

/**
 * Helpers for the migration tests: a schema that looks like a site's, and a
 * throwaway database to run concurrent boots against.
 */

/**
 * The tables a site's own Billet app creates, as a site would have them.
 *
 * Reproduced from Billet v5.1.0's own migrations, names and all: the CMS's
 * whole reason for the `cms_` prefix is that the site's `users`, `sessions`,
 * `user_tokens` and `migrations` already exist, along with the indexes and
 * constraints below. The CMS's relations must not collide with any of them, so
 * a fixture that left the index names out would prove less than it looks.
 */
/**
 * The site's own `users` table, as a site would have it.
 *
 * Shared with the test-database setup, which creates the same table in every
 * worker database so the CMS's `cms_identities` view has something to read.
 * `IF NOT EXISTS` keeps the setup idempotent across runs.
 */
export const SITE_USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   email VARCHAR(255) NOT NULL UNIQUE,
   created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
   role VARCHAR(20) NOT NULL DEFAULT 'user'
     CHECK (role IN ('user', 'admin'))
 )`;

/**
 * The same `users` table as a password-mode site has it.
 *
 * Upstream's `007_add_password_credentials` adds `password_hash` and
 * `email_verified_at` to the table, both nullable; password mode is the one
 * that fills the hash in. The CMS reaches accounts only through
 * `cms_identities`, which selects `id, email, role`, so a test built on this
 * table is how both halves of the password-mode coverage are proved: sign-in
 * works over it, and the credential itself is never read or written.
 */
export const SITE_PASSWORD_USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   email VARCHAR(255) NOT NULL UNIQUE,
   password_hash TEXT NULL,
   email_verified_at TIMESTAMPTZ NULL,
   created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
   role VARCHAR(20) NOT NULL DEFAULT 'user'
     CHECK (role IN ('user', 'admin'))
 )`;

const SITE_TABLES_AFTER_USERS = [
  `CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     last_activity_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
     created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
     csrf_secret TEXT NULL,
     session_type VARCHAR(20) NOT NULL DEFAULT 'authenticated'
   )`,
  `CREATE TABLE user_tokens (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     type VARCHAR(50) NOT NULL DEFAULT 'magic_link',
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ NULL,
     created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE migrations (
     id VARCHAR(255) PRIMARY KEY,
     name VARCHAR(255) NOT NULL,
     applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
   )`,
  // Billet v5.1.0's indexes, under their upstream names. These are the ones a
  // renamed CMS index could collide with if the rename were half-done.
  "CREATE INDEX idx_sessions_user_id ON sessions(user_id)",
  "CREATE INDEX idx_sessions_expires_at ON sessions(expires_at)",
  "CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at)",
  `CREATE INDEX idx_sessions_csrf_secret ON sessions(csrf_secret)
     WHERE csrf_secret IS NOT NULL`,
  "CREATE INDEX idx_sessions_session_type ON sessions(session_type)",
  "CREATE INDEX idx_user_tokens_user_id ON user_tokens(user_id)",
  "CREATE INDEX idx_user_tokens_type ON user_tokens(type)",
  "CREATE INDEX idx_user_tokens_expires_at ON user_tokens(expires_at)",
] as const;

const SITE_TABLES = [SITE_USERS_DDL, ...SITE_TABLES_AFTER_USERS] as const;

const SITE_PASSWORD_TABLES = [
  SITE_PASSWORD_USERS_DDL,
  ...SITE_TABLES_AFTER_USERS,
] as const;

export const createSiteTables = async (sql: SQL): Promise<void> => {
  for (const statement of SITE_TABLES) {
    await sql.unsafe(statement);
  }
};

/**
 * The same site in password mode: `users` carries the credential columns, so a
 * site that signs its editors in with a password still has a `users` table the
 * CMS can read through `cms_identities`.
 */
export const createPasswordSiteTables = async (sql: SQL): Promise<void> => {
  for (const statement of SITE_PASSWORD_TABLES) {
    await sql.unsafe(statement);
  }
};

/** Every table and view in the current schema. */
export const relationNames = async (sql: SQL): Promise<string[]> => {
  const rows = await sql`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p', 'v')
    ORDER BY c.relname
  `;
  return (rows as { relname: string }[]).map((row) => row.relname);
};

/**
 * Every named object in the current schema, as `kind:name` strings.
 *
 * Wider than `relationNames`: `pg_class` at every relkind (tables, views,
 * indexes, sequences, materialised views), plus constraints, non-array types,
 * functions and triggers. Diffing this before and after a CMS boot proves the
 * CMS adds nothing that isn't `cms_`-prefixed — an index or a CHECK constraint
 * with a hand-picked name is exactly the object a prefix review misses.
 *
 * Array types are excluded on purpose: Postgres names one `_<table>` for every
 * table, so `cms_users` brings a `_cms_users` the CMS never chose and could not
 * rename. Every other object in the schema is listed.
 */
export const schemaObjectNames = async (sql: SQL): Promise<string[]> => {
  const rows = await sql`
    SELECT kind, name FROM (
      SELECT 'relation' AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
      UNION
      SELECT 'constraint', con.conname
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
      UNION
      SELECT 'type', t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
        AND t.typcategory <> 'A'
      UNION
      SELECT 'function', p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
      UNION
      SELECT 'trigger', tg.tgname
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND NOT tg.tgisinternal
    ) objects
    ORDER BY kind, name
  `;
  return (rows as { kind: string; name: string }[]).map(
    (row) => `${row.kind}:${row.name}`,
  );
};

/** The bare object name out of a `kind:name` pair from `schemaObjectNames`. */
export const objectName = (labelled: string): string => {
  const separator = labelled.indexOf(":");
  return separator === -1 ? labelled : labelled.slice(separator + 1);
};

export interface TempDatabase {
  name: string;
  url: string;
  open: () => SQL;
  /**
   * A single connection, for a test that needs session state — a `SET
   * search_path`, a temporary table — to survive across queries. `open()`'s
   * pool can hand the next query a different connection and lose it.
   */
  openOne: () => SQL;
  drop: () => Promise<void>;
}

/**
 * A database of its own, created for one test and dropped afterwards.
 *
 * Every migration test works against one of these rather than the suite's
 * shared database: the tests drop and recreate the CMS's relations, and a
 * transaction can't be nested to undo that safely.
 */
export const createTempDatabase = async (
  suffix: string,
): Promise<TempDatabase> => {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is required for tests");

  const name = `${databaseName(baseUrl)}-${suffix}`;
  const admin = new SQL(withDatabase(baseUrl, "postgres"), { max: 1 });

  try {
    // FORCE (Postgres 13+) evicts a connection a previous run leaked, so a
    // flaky teardown can't wedge the next one.
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
    );
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(baseUrl, name);
  const clients: SQL[] = [];

  return {
    name,
    url,
    open: () => {
      const client = new SQL(url, { max: 3, idleTimeout: 5 });
      clients.push(client);
      return client;
    },
    openOne: () => {
      const client = new SQL(url, { max: 1, idleTimeout: 5 });
      clients.push(client);
      return client;
    },
    drop: async () => {
      for (const client of clients) {
        await client.end();
      }
      const closer = new SQL(withDatabase(baseUrl, "postgres"), { max: 1 });
      try {
        await closer.unsafe(
          `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
        );
      } finally {
        await closer.end();
      }
    },
  };
};
