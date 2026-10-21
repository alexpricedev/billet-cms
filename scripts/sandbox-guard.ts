/**
 * The guards every sandbox entry point runs first.
 *
 * The fixture loader truncates the CMS's content tables and the fixture site's
 * `users`, so it must never run against a real site's database. Each entry
 * script calls `assertSandboxSafe` before it imports anything that opens a
 * database pool (`app`'s `db` module connects as soon as it loads), which is why
 * the rest of each script is loaded with a dynamic `import()`.
 *
 * Same rules as Billet's fixtures: refuse under `NODE_ENV=production`, and
 * refuse unless the `DATABASE_URL` host is local, with `FIXTURES_ALLOW_REMOTE=1`
 * as the explicit override for the host check.
 */

export type SandboxEnv = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** The host of a connection string, without the brackets around an IPv6 one. */
export const databaseHost = (databaseUrl: string): string | null => {
  try {
    return new URL(databaseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
};

export const assertSandboxSafe = (env: SandboxEnv = process.env): void => {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: NODE_ENV=production. The sandbox and fixtures are for local development and tests only.",
    );
  }

  const url = env.DATABASE_URL;
  if (!url) throw new Error("Refusing to run: DATABASE_URL is not set.");

  const host = databaseHost(url);
  if (host === null) {
    throw new Error("Refusing to run: DATABASE_URL is not a valid URL.");
  }
  if (LOCAL_HOSTS.has(host) || env.FIXTURES_ALLOW_REMOTE === "1") return;

  throw new Error(
    `Refusing to run against database host "${host}": the sandbox only runs against localhost, 127.0.0.1 or ::1. Set FIXTURES_ALLOW_REMOTE=1 to override.`,
  );
};

/** For entry scripts: refuse with the message and a non-zero exit. */
export const guardOrExit = (env: SandboxEnv = process.env): void => {
  try {
    assertSandboxSafe(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
