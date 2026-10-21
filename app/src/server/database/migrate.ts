import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { db } from "../services/database";
import { log } from "../services/logger";
import { LOCK_NAMESPACE, MIGRATION_LOCK_SUBKEY } from "./advisory-locks";

export type Migration = {
  id: string;
  name: string;
  applied_at: Date;
};

// The migration lock is the shared `billet-cms` advisory-lock namespace's subkey
// 1 (`advisory-locks.ts`): it never waits on the identity-view lock (subkey 2),
// and neither collides with another app's lock. It is taken transaction-scoped,
// so a crashed boot releases it with the transaction.

// Beside this file, not under the working directory, so the fixture loader can
// run the migrations from the repository root.
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/**
 * Ensure the tracking table exists.
 *
 * Deliberately not named `migrations`: the CMS shares a database with the site
 * it serves, and the site's own Billet app has a `migrations` table of its own.
 */
export const ensureMigrationsTable = async (sql: SQL = db): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS cms_migrations (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;
};

/**
 * The migrations recorded as applied, without creating anything.
 *
 * Read-only on purpose: `migrate:status` calls this, and a status command must
 * not write. `runMigrations` creates the table itself inside its locked
 * transaction, so a database with no `cms_migrations` yet answers "nothing
 * applied" rather than being altered to find out.
 */
export const getAppliedMigrations = async (
  sql: SQL = db,
): Promise<Migration[]> => {
  const exists = (await sql`
    SELECT to_regclass('cms_migrations') AS relation
  `) as { relation: string | null }[];
  if (!exists[0]?.relation) return [];
  const results =
    await sql`SELECT id, name, applied_at FROM cms_migrations ORDER BY id`;
  return results as Migration[];
};

export const recordMigration = async (
  id: string,
  name: string,
  sql: SQL = db,
): Promise<void> => {
  await sql`INSERT INTO cms_migrations (id, name) VALUES (${id}, ${name})`;
};

export const removeMigration = async (
  id: string,
  sql: SQL = db,
): Promise<void> => {
  await sql`DELETE FROM cms_migrations WHERE id = ${id}`;
};

/**
 * Migration files on disk, in filename order.
 */
const listMigrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".ts"))
    .sort();

const migrationId = (filename: string): string => filename.replace(".ts", "");

/**
 * The path of a migration that is actually on disk.
 *
 * `runMigration` and `rollbackMigration` import whatever they are handed, and
 * `rollbackLastMigration` builds that name from a `cms_migrations` row — a row
 * (or a caller) naming `../../something` would otherwise make the process import
 * a file outside the migrations directory. Restricting the name to the files
 * `listMigrationFiles` sees closes that and turns a typo into a clear "no such
 * migration" instead of a module-resolution error.
 */
const migrationPath = (filename: string): string => {
  if (!listMigrationFiles().includes(filename)) {
    throw new Error(`No such migration: ${filename}`);
  }
  // `listMigrationFiles` only ever returns bare names, so this stays inside the
  // directory.
  return join(MIGRATIONS_DIR, filename);
};

/**
 * Migration files that haven't been applied yet, in filename order.
 */
export const getPendingMigrations = async (
  sql: SQL = db,
): Promise<string[]> => {
  const appliedMigrations = await getAppliedMigrations(sql);
  const appliedIds = new Set(appliedMigrations.map((m) => m.id));

  return listMigrationFiles().filter(
    (file) => !appliedIds.has(migrationId(file)),
  );
};

/**
 * Run a single migration file and record it as applied.
 *
 * `sql` is the connection the caller holds a migration lock on, so the DDL and
 * the row that records it commit together.
 */
export const runMigration = async (
  filename: string,
  sql: SQL = db,
): Promise<void> => {
  const path = migrationPath(filename);
  const migration = await import(path);

  if (typeof migration.up !== "function") {
    throw new Error(`Migration ${filename} does not export an 'up' function`);
  }

  await migration.up(sql);

  const id = migrationId(filename);
  const name = filename.replace(/^\d+_/, "").replace(".ts", "");
  await recordMigration(id, name, sql);

  log.info("migrations", `Applied: ${filename}`);
};

/**
 * Write the contract version this build speaks into `cms_meta`.
 *
 * Upserted rather than inserted: a deploy of a newer CMS must overwrite the row
 * the previous build left, and the site's publish step reads it to decide
 * whether the two are compatible. It also creates the single row on a database
 * that has the table (migration 004) but no row yet. `content_version` is left
 * alone: the CMS bumps it when published content changes, and the site's plugin
 * polls it.
 */
export const syncContractVersion = async (sql: SQL = db): Promise<void> => {
  await sql`
    INSERT INTO cms_meta (id, contract_version)
    VALUES (1, ${CONTRACT_VERSION})
    ON CONFLICT (id) DO UPDATE
      SET contract_version = EXCLUDED.contract_version,
          updated_at = CURRENT_TIMESTAMP
  `;
};

/**
 * Apply every pending migration, once, even when several instances boot at once.
 *
 * The whole run happens inside one transaction that first takes a Postgres
 * advisory lock. Concurrent boots queue on the lock rather than racing: the
 * loser waits, then re-reads `cms_migrations` inside its own transaction and
 * finds nothing left to do. Without the lock two instances both see an empty
 * table, both run `CREATE TABLE`, and one dies on "already exists" — the failure
 * surfaces on a deploy that was correct on the previous, single-instance run.
 *
 * DDL is transactional in Postgres, so a migration that fails part-way rolls
 * back with the lock and the next boot retries cleanly.
 */
export const runMigrations = async (sql: SQL = db): Promise<void> => {
  let appliedCount = 0;

  await sql.begin(async (tx) => {
    // The lock is taken before anything is read or created. Two instances
    // booting together would otherwise race on `CREATE TABLE IF NOT EXISTS
    // cms_migrations` — a check-then-create that Postgres can still lose with a
    // duplicate-key error on its own system catalogue.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), ${MIGRATION_LOCK_SUBKEY})`;

    await ensureMigrationsTable(tx);

    const applied = new Set(
      ((await tx`SELECT id FROM cms_migrations`) as { id: string }[]).map(
        (row) => row.id,
      ),
    );
    const pending = listMigrationFiles().filter(
      (file) => !applied.has(migrationId(file)),
    );
    appliedCount = pending.length;

    if (pending.length === 0) {
      log.info("migrations", "No pending migrations");
      return;
    }

    log.info("migrations", `Running ${pending.length} pending migrations...`);
    for (const migration of pending) {
      await runMigration(migration, tx);
    }
  });

  // After the transaction commits, so the row can only be written once the
  // migration that creates `cms_meta` has landed.
  await syncContractVersion(sql);

  if (appliedCount > 0) {
    log.info("migrations", "All migrations completed");
  }
};

export const rollbackMigration = async (
  filename: string,
  sql: SQL = db,
): Promise<void> => {
  const path = migrationPath(filename);
  const migration = await import(path);

  if (typeof migration.down !== "function") {
    throw new Error(`Migration ${filename} does not export a 'down' function`);
  }

  await migration.down(sql);

  const id = migrationId(filename);
  await removeMigration(id, sql);

  log.info("migrations", `Rolled back: ${filename}`);
};

/**
 * Roll the last applied migration back, once, under the same advisory lock a
 * boot takes.
 *
 * The lock and the transaction are what `runMigrations` uses, for the same
 * reason: two operators (or one racing with a boot) rolling back or applying at
 * once would otherwise interleave DDL and the `cms_migrations` row. Postgres DDL
 * is transactional, so a `down` that fails part-way rolls back with its row and
 * the next run retries cleanly rather than leaving a half-dropped schema the
 * runner thinks is still applied.
 */
export const rollbackLastMigration = async (sql: SQL = db): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), ${MIGRATION_LOCK_SUBKEY})`;
    await ensureMigrationsTable(tx);

    const rows = (await tx`
      SELECT id FROM cms_migrations ORDER BY id DESC LIMIT 1
    `) as { id: string }[];

    if (rows.length === 0) {
      log.info("migrations", "No migrations to rollback");
      return;
    }

    await rollbackMigration(`${rows[0].id}.ts`, tx);
  });
};
