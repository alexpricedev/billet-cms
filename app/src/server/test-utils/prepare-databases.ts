#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * Prepare one test database for the suite: the CMS's own migrations have run,
 * and this adds the site-side fixture the CMS reads through.
 *
 * The CMS signs people in through `cms_identities`, a view over the site's
 * `users` table. The CMS does not create that table — it belongs to the site —
 * so a test database has to carry a stand-in before any identity test can run.
 * `ensureIdentitiesView` then builds the view the same way a boot would.
 *
 * Run against each worker database by `run-tests.ts`, and by `bootstrap.ts`.
 */
import { SQL } from "bun";
import { ensureIdentitiesView } from "../database/identity-view";
import { SITE_USERS_DDL } from "./migration-helpers";

export const prepareDatabase = async (sql: SQL): Promise<void> => {
  await sql.unsafe(SITE_USERS_DDL);
  await ensureIdentitiesView(sql);
};

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("prepare-databases needs DATABASE_URL");
    process.exit(1);
  }

  const sql = new SQL(url, { max: 1 });
  try {
    await prepareDatabase(sql);
  } catch (error) {
    console.error("Failed to prepare the test database:", error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}
