import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { db } from "../services/database";
import { log } from "../services/logger";

export type Migration = {
  id: string;
  name: string;
  applied_at: Date;
};

// The advisory lock key every CMS process takes while it migrates. Arbitrary
// but fixed: it only has to be the same in every instance of this app, and
// different from any other app sharing the database. Taken
// transaction-scoped, so a crashed boot releases it with the transaction.
//
// Bound as a string and cast: a JS number would be sent as a numeric and match
// no overload of pg_advisory_xact_lock.
const MIGRATION_LOCK_KEY = "8041000001";

const MIGRATIONS_DIR = join(process.cwd(), "src/server/database/migrations");

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

export const getAppliedMigrations = async (
  sql: SQL = db,
): Promise<Migration[]> => {
  await ensureMigrationsTable(sql);
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

export const removeMigration = async (id: string): Promise<void> => {
  await db`DELETE FROM cms_migrations WHERE id = ${id}`;
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
  const migrationPath = join(MIGRATIONS_DIR, filename);
  const migration = await import(migrationPath);

  if (typeof migration.up !== "function") {
    throw new Error(`Migration ${filename} does not export an 'up' function`);
  }

  await migration.up(sql);

  const id = filename.replace(".ts", "");
  const name = filename.replace(/^\d+_/, "").replace(".ts", "");
  await recordMigration(id, name, sql);

  log.info("migrations", `Applied: ${filename}`);
};

/**
 * Write the contract version this build speaks into `cms_meta`.
 *
 * Upserted rather than inserted: a deploy of a newer CMS must overwrite the row
 * the previous build left, and the site's publish step reads it to decide
 * whether the two are compatible. `content_version` is left alone — the site
 * owns that counter.
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
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY}::bigint)`;

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
  const migrationPath = join(MIGRATIONS_DIR, filename);
  const migration = await import(migrationPath);

  if (typeof migration.down !== "function") {
    throw new Error(`Migration ${filename} does not export a 'down' function`);
  }

  await migration.down(sql);

  const id = filename.replace(".ts", "");
  await removeMigration(id);

  log.info("migrations", `Rolled back: ${filename}`);
};

export const rollbackLastMigration = async (): Promise<void> => {
  const appliedMigrations = await getAppliedMigrations();

  if (appliedMigrations.length === 0) {
    log.info("migrations", "No migrations to rollback");
    return;
  }

  const lastMigration = appliedMigrations[appliedMigrations.length - 1];
  const filename = `${lastMigration.id}.ts`;

  await rollbackMigration(filename);
};
