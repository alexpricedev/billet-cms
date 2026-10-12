#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

import { SQL } from "bun";

/**
 * Test database bootstrap script
 * Use: bun --env-file=.env.test run src/server/test-utils/bootstrap.ts
 */

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in .env.test");
}

const db = new SQL(process.env.DATABASE_URL);

/**
 * Bootstrap test database
 * - Drop every cms_ relation CASCADE (clean slate)
 * - Run migrations fresh
 *
 * Only the CMS's own relations are dropped. The site's tables are not this
 * script's to touch — `drop schema` or a blanket sweep would take them with it.
 */
export async function bootstrap() {
  console.log("🧪 Bootstrapping test database...");

  try {
    console.log("  Dropping CMS relations...");
    await db`DROP VIEW IF EXISTS cms_identities CASCADE`;
    await db`DROP TABLE IF EXISTS cms_user_tokens CASCADE`;
    await db`DROP TABLE IF EXISTS cms_sessions CASCADE`;
    await db`DROP TABLE IF EXISTS cms_users CASCADE`;
    await db`DROP TABLE IF EXISTS cms_meta CASCADE`;
    await db`DROP TABLE IF EXISTS cms_migrations CASCADE`;

    console.log("  Running migrations...");
    const { runMigrations } = await import("../database/migrate");
    await runMigrations();

    console.log("✅ Test database bootstrap complete!");
  } catch (error) {
    console.error("❌ Test database bootstrap failed:", error);
    process.exit(1);
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  await bootstrap();
}
