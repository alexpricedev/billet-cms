#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * `cms:publish` — the site's deploy step.
 *
 * Usage: `bunx billet-cms-publish [config]`, where `config` defaults to
 * `cms.config.ts` in the working directory. Reads `DATABASE_URL`, loads the
 * site's declarations, and writes them into the CMS's tables.
 */
import { SQL } from "bun";
import { loadDefinitions } from "./load";
import { type PublishSummary, publish } from "./publish";
import { CmsNotSetUpError, ContractVersionMismatchError } from "./version";

const configPath = process.argv[2] ?? "cms.config.ts";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("cms:publish needs DATABASE_URL to reach the CMS's database.");
  process.exit(1);
}

const count = (n: number, singular: string): string =>
  `${n} ${singular}${n === 1 ? "" : "s"}`;

const describe = (summary: PublishSummary): string => {
  if (!summary.changed) {
    return `Definitions already up to date (content version ${summary.contentVersion}).`;
  }

  const published = [
    count(summary.blocks, "block type"),
    count(summary.pageTypes, "page type"),
    count(summary.slots, "slot"),
  ].join(", ");

  const removedTotal =
    summary.removedBlocks + summary.removedPageTypes + summary.removedSlots;
  const removed =
    removedTotal > 0
      ? ` Marked ${count(removedTotal, "definition")} removed.`
      : "";

  return `Published ${published}.${removed} Content version ${summary.contentVersion}.`;
};

const sql = new SQL(databaseUrl, { max: 1 });

/**
 * Failures the CLI has a written message for: the CMS isn't set up, or its
 * contract version doesn't match. Everything else — an unreachable database, a
 * config module that throws, a bug — is unexpected, and its message alone
 * usually hides the cause.
 */
const isExpectedFailure = (error: unknown): error is Error =>
  error instanceof CmsNotSetUpError ||
  error instanceof ContractVersionMismatchError;

try {
  const definitions = await loadDefinitions(configPath);
  const summary = await publish(sql, definitions);
  console.log(describe(summary));
} catch (error) {
  if (isExpectedFailure(error)) {
    console.error(`\n${error.message}\n`);
  } else {
    // Print the whole error, stack and all: an operator reading a deploy log
    // needs something to go on, and a wrapped one-line message would not.
    console.error("\nUnexpected error while publishing definitions:\n");
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
