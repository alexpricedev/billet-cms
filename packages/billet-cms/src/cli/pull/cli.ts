#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * `cms:pull` — replace local `cms_` content with a CMS's published export.
 *
 * Usage:
 *   CMS_EXPORT_TOKEN=… bunx billet-cms-pull --from https://cms.example.com
 *   CMS_EXPORT_TOKEN=… bun run cms:pull --from https://cms.example.com
 *
 * The token comes from the `CMS_EXPORT_TOKEN` environment variable, or `--token`
 * — prefer the variable, because a flag lands in your shell history and in a
 * process listing. The database comes from `DATABASE_URL`. Refuses to run under
 * `NODE_ENV=production`.
 */
import { SQL } from "bun";
import { pullFrom } from "./pull";

/** Read `--flag value` pairs from argv. */
const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing value for --${name}`);
    process.exit(1);
  }
  return value;
};

const from = readFlag("from");
const token = readFlag("token") ?? process.env.CMS_EXPORT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

if (!from) {
  console.error("cms:pull needs --from <cms-url>.");
  process.exit(1);
}
if (!token) {
  console.error(
    "cms:pull needs an export token: set CMS_EXPORT_TOKEN (preferred) or pass --token <token>.",
  );
  process.exit(1);
}
if (!databaseUrl) {
  console.error("cms:pull needs DATABASE_URL to write into.");
  process.exit(1);
}

const sql = new SQL(databaseUrl, { max: 1 });

try {
  const summary = await pullFrom({ from, token, sql });
  console.log(
    `Pulled ${summary.pages} page${summary.pages === 1 ? "" : "s"}, ` +
      `${summary.slots} slot${summary.slots === 1 ? "" : "s"}, ` +
      `${summary.revisions} revision${summary.revisions === 1 ? "" : "s"}, ` +
      `${summary.redirects} redirect${summary.redirects === 1 ? "" : "s"} and ` +
      `${summary.media} media row${summary.media === 1 ? "" : "s"}. ` +
      `Local content version ${summary.contentVersion}.`,
  );
} catch (error) {
  console.error(
    `\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
