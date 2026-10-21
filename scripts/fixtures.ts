#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * `bun run fixtures`: reload the Northwind fixtures and nothing else.
 *
 * Truncates the CMS's content tables and the fixture site's `users`, so the
 * guards run before anything that could open a database pool is imported.
 */
import { SANDBOX_PEPPER } from "../fixtures/constants.ts";
import { sandboxConfig } from "./sandbox-config.ts";
import { guardOrExit } from "./sandbox-guard.ts";

guardOrExit();

// `app`'s database module reads these when it loads, which is why it is only
// imported below, after the guard.
process.env.CRYPTO_PEPPER = SANDBOX_PEPPER;
const { SQL } = await import("bun");
const { loadFixtures } = await import("../fixtures/load.ts");

const config = sandboxConfig(process.env);
const sql = new SQL(process.env.DATABASE_URL as string, { max: 2 });
try {
  await loadFixtures({
    sql,
    siteUrl: config.siteUrl,
    mediaDir: config.mediaDir,
  });
  console.log("Fixtures loaded.");
} finally {
  await sql.close();
}
process.exit(0);
