import { SQL } from "bun";
import { databaseName, quoteIdent, withDatabase } from "./worker-database";

/**
 * Helpers for the migration tests: a schema that looks like a site's, and a
 * throwaway database to run concurrent boots against.
 */

/**
 * The tables a site's own Billet app creates, as a site would have them.
 *
 * Only the shape the CMS interacts with matters here: `users` carries the
 * `role` column `cms_identities` filters on, and the rest exist to prove the
 * CMS's cms_-prefixed names can't collide with them.
 */
const SITE_TABLES = [
  `CREATE TABLE users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email VARCHAR(255) NOT NULL UNIQUE,
     role VARCHAR(20) NOT NULL DEFAULT 'user',
     created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE user_tokens (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     type VARCHAR(50) NOT NULL DEFAULT 'magic_link',
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE migrations (
     id VARCHAR(255) PRIMARY KEY,
     name VARCHAR(255) NOT NULL,
     applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
   )`,
] as const;

export const createSiteTables = async (sql: SQL): Promise<void> => {
  for (const statement of SITE_TABLES) {
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

export interface TempDatabase {
  name: string;
  url: string;
  open: () => SQL;
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
