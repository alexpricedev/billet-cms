import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTempDatabase } from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";

/**
 * `cms:publish` end to end, through the real CLI and a real database.
 *
 * The unit tests cover `publish()`; this runs the binary a site's deploy runs
 * (`bunx billet-cms-publish <config>`), so the exit codes, the human summary
 * and the failure message are tested as an operator sees them.
 */
const repoRoot = join(import.meta.dir, "../../../..");
const cli = join(repoRoot, "packages/billet-cms/src/cli/publish/cli.ts");
const fixture = join(
  repoRoot,
  "packages/billet-cms/src/cli/publish/fixtures/site-config.ts",
);

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runCli = async (databaseUrl: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, fixture],
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("cms:publish CLI", () => {
  test("publishes the fixture, reports up to date on a rerun, and fails on a version mismatch", async () => {
    const temp = await createTempDatabase("publish-cli");

    try {
      const sql = temp.open();
      await runMigrations(sql);

      const first = await runCli(temp.url);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(
        "Published 1 block type, 1 page type, 1 slot.",
      );
      expect(first.stdout).toContain("Content version 2.");

      const second = await runCli(temp.url);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already up to date");
      expect(second.stdout).toContain("content version 2");

      await sql`UPDATE cms_meta SET contract_version = '0.0.1' WHERE id = 1`;

      const mismatch = await runCli(temp.url);
      expect(mismatch.exitCode).toBe(1);
      expect(mismatch.stderr).toMatch(/contract version mismatch/i);
      expect(mismatch.stderr).toContain("0.0.1");
    } finally {
      await temp.drop();
    }
  });
});
