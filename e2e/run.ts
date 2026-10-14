#!/usr/bin/env bun

/* biome-ignore-all lint/suspicious/noConsole: CLI script */

/**
 * Runs the end-to-end suite.
 *
 * A thin wrapper so the suite runs with `NODE_ENV=test` however it is invoked:
 * the test itself spawns the CMS and a site against the database `.env.test`
 * names, and `bun test` must not load the developer's `.env` over it.
 */
const tests = Bun.spawn(
  ["bun", "test", "--timeout", "30000", "e2e/e2e.test.ts"],
  {
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await tests.exited);

// Marks the file as a module so the top-level `await` above is legal.
export {};
