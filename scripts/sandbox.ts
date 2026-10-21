#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * `bun run sandbox`: the fixture site (Northwind Studio) and the CMS, running
 * together on one local database, holding the same people and content every
 * time.
 *
 * Loads the fixtures, publishes the site's definitions, starts the site in this
 * process and the CMS as a subprocess pointed at each other, prints both URLs,
 * and stops both on Ctrl-C. The guards run before anything opens a database.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_PEPPER } from "../fixtures/constants.ts";
import { PERSONAS } from "../fixtures/personas.ts";
import { sandboxConfig } from "./sandbox-config.ts";
import { guardOrExit } from "./sandbox-guard.ts";

guardOrExit();

process.env.CRYPTO_PEPPER = SANDBOX_PEPPER;
const { SQL } = await import("bun");
const { loadFixtures } = await import("../fixtures/load.ts");
const { createSite } = await import("../e2e/site.ts");

const root = join(import.meta.dir, "..");
const config = sandboxConfig(process.env);
const databaseUrl = process.env.DATABASE_URL as string;

const sql = new SQL(databaseUrl, { max: 5 });
await loadFixtures({
  sql,
  siteUrl: config.siteUrl,
  mediaDir: config.mediaDir,
});

// Pages are unstyled without the CSS and the editor scripts, so build them once.
if (!existsSync(join(root, "app", "dist", "assets", "main.css"))) {
  console.log("Building the CMS assets (first run)...");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) process.exit(1);
}

const site = createSite(sql, {
  cmsUrl: config.cmsUrl,
  mediaDir: config.mediaDir,
});
const siteServer = Bun.serve({
  port: config.sitePort,
  fetch: (req) => site.handler(req),
});

const cms = Bun.spawn({
  cmd: ["bun", "--no-env-file", "run", "src/server/main.ts"],
  cwd: join(root, "app"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    CRYPTO_PEPPER: SANDBOX_PEPPER,
    PORT: String(config.cmsPort),
    APP_NAME: "Billet CMS (sandbox)",
    APP_URL: config.cmsUrl,
    SITE_APP_URL: config.siteUrl,
    SESSION_COOKIE_NAME: config.cmsCookieName,
    MEDIA_LOCAL_DIR: config.mediaDir,
    MEDIA_PUBLIC_BASE_URL: `${config.siteUrl}/media`,
  },
  stdout: "inherit",
  stderr: "inherit",
});

const stop = async (code: number): Promise<never> => {
  cms.kill();
  siteServer.stop(true);
  await cms.exited;
  await sql.close();
  process.exit(code);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
void cms.exited.then((code) => {
  console.error(`The CMS exited (code ${code}).`);
  void stop(code || 1);
});

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    if ((await fetch(`${config.cmsUrl}/health`)).ok) break;
  } catch {
    // Not listening yet.
  }
  if (Date.now() > deadline) {
    console.error("The CMS did not start in time.");
    await stop(1);
  }
  await Bun.sleep(250);
}

console.log(`
Sandbox ready.
  Site: ${config.siteUrl}
  CMS:  ${config.cmsUrl}

Sign in as a persona (${PERSONAS.map((p) => p.key).join(", ")}):
  bun run scripts/persona-session.ts leo --side site   # site cookie, then press Edit content
  bun run scripts/persona-session.ts leo --side cms    # CMS cookie, skips the handoff
Or sign in at ${config.siteUrl}/login with a persona's email.
Ctrl-C stops both.`);
