import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SQL } from "bun";
import { createSite } from "../e2e/site.ts";
import { assertSandboxSafe, databaseHost } from "../scripts/sandbox-guard.ts";
import { CMS_COOKIE_NAME, SANDBOX_PEPPER } from "./constants.ts";
import { LONG_TITLE } from "./content.ts";
import { dumpFixtureTables, loadFixtures } from "./load.ts";
import { PERSONAS } from "./personas.ts";

/**
 * The sandbox's own tests: the fixtures load the same way twice, every persona
 * gets a session that works on its side, Tom is turned away, and the guards
 * refuse. The CMS runs as a real subprocess and the site on a real port, as in
 * the e2e suite, against the database `.env.test` names.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the fixtures suite");
}
const ROOT = join(import.meta.dir, "..");

const pickFreePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve did not bind a port");
  return port;
};

/** Run a script from the repository root, with an explicit environment. */
const run = async (
  script: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", "--no-env-file", ...script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
};

describe("guards", () => {
  const local = "postgresql://postgres@127.0.0.1:5432/x";

  test("refuse NODE_ENV=production", () => {
    expect(() =>
      assertSandboxSafe({ NODE_ENV: "production", DATABASE_URL: local }),
    ).toThrow("NODE_ENV=production");
  });

  test("refuse a remote host, naming it", () => {
    expect(() =>
      assertSandboxSafe({
        DATABASE_URL: "postgresql://u:p@db.example.com:5432/prod",
      }),
    ).toThrow('"db.example.com"');
  });

  test("accept localhost, 127.0.0.1 and [::1]", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() =>
        assertSandboxSafe({ DATABASE_URL: `postgresql://u@${host}:5432/x` }),
      ).not.toThrow();
    }
    expect(databaseHost("postgresql://u@[::1]:5432/x")).toBe("::1");
  });

  test("FIXTURES_ALLOW_REMOTE=1 overrides the host check only", () => {
    const remote = "postgresql://u@db.example.com/x";
    expect(() =>
      assertSandboxSafe({ DATABASE_URL: remote, FIXTURES_ALLOW_REMOTE: "1" }),
    ).not.toThrow();
    expect(() =>
      assertSandboxSafe({
        DATABASE_URL: remote,
        FIXTURES_ALLOW_REMOTE: "1",
        NODE_ENV: "production",
      }),
    ).toThrow("production");
  });

  test("refuse a missing or malformed DATABASE_URL", () => {
    expect(() => assertSandboxSafe({})).toThrow("DATABASE_URL");
    expect(() => assertSandboxSafe({ DATABASE_URL: "not a url" })).toThrow(
      "not a valid URL",
    );
  });

  // The commands refuse before they import the database module, so a remote
  // host never gets a connection attempt: with no CRYPTO_PEPPER and no server
  // anywhere, all they can do is print the refusal.
  const commands = [
    ["scripts/fixtures.ts"],
    ["scripts/sandbox.ts"],
    ["scripts/persona-session.ts", "leo", "--side", "site"],
  ];
  for (const command of commands) {
    test(`${command[0]} refuses a remote host and names it`, async () => {
      const result = await run(command, {
        DATABASE_URL: "postgresql://u:p@db.example.com:5432/prod",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("db.example.com");
    });

    test(`${command[0]} refuses NODE_ENV=production`, async () => {
      const result = await run(command, {
        DATABASE_URL: local,
        NODE_ENV: "production",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("NODE_ENV=production");
    });
  }
});

describe("fixtures and personas", () => {
  let sql: SQL;
  let siteServer: ReturnType<typeof Bun.serve>;
  let siteUrl: string;
  let cmsUrl: string;
  let cms: Subprocess;
  let mediaDir: string;
  let before: Record<string, unknown[]>;
  let after: Record<string, unknown[]>;

  const scriptEnv = (): Record<string, string | undefined> => ({
    DATABASE_URL,
    SANDBOX_CMS_PORT: new URL(cmsUrl).port,
    SANDBOX_SITE_PORT: new URL(siteUrl).port,
    SANDBOX_MEDIA_DIR: mediaDir,
  });

  const cookieFor = async (key: string, side: "site" | "cms") =>
    run(["scripts/persona-session.ts", key, "--side", side], scriptEnv());

  beforeAll(async () => {
    sql = new SQL(DATABASE_URL, { max: 5 });
    mediaDir = mkdtempSync(join(tmpdir(), "northwind-media-"));

    const cmsPort = pickFreePort();
    cmsUrl = `http://localhost:${cmsPort}`;
    const site = createSite(sql, { cmsUrl, mediaDir });
    siteServer = Bun.serve({ port: 0, fetch: (req) => site.handler(req) });
    siteUrl = `http://localhost:${siteServer.port}`;

    const options = { sql, siteUrl, mediaDir };
    await loadFixtures(options);
    before = await dumpFixtureTables(sql);
    await loadFixtures(options);
    after = await dumpFixtureTables(sql);

    cms = Bun.spawn({
      cmd: ["bun", "--no-env-file", "run", "src/server/main.ts"],
      cwd: join(ROOT, "app"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL,
        CRYPTO_PEPPER: SANDBOX_PEPPER,
        PORT: String(cmsPort),
        APP_NAME: "Billet CMS",
        APP_URL: cmsUrl,
        SITE_APP_URL: siteUrl,
        SESSION_COOKIE_NAME: CMS_COOKIE_NAME,
        MEDIA_LOCAL_DIR: mediaDir,
        MEDIA_PUBLIC_BASE_URL: `${siteUrl}/media`,
      },
      stdout: "ignore",
      stderr: "inherit",
    });

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${cmsUrl}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error("The CMS did not start");
      await Bun.sleep(200);
    }
  }, 60_000);

  afterAll(async () => {
    cms?.kill();
    await cms?.exited;
    siteServer?.stop(true);
    await sql?.close();
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
  });

  test("loading twice gives identical rows", () => {
    expect(after).toEqual(before);
  });

  test("the content is what ux/personas.md lists", async () => {
    expect(after.users).toHaveLength(5);
    expect(after.cms_media).toHaveLength(6);
    expect(after.cms_redirects).toHaveLength(1);
    expect(after.cms_export_tokens).toHaveLength(2);

    const pages = (await sql`
      SELECT url, published_revision_id FROM cms_pages ORDER BY url
    `) as { url: string; published_revision_id: string | null }[];
    expect(pages.map((page) => page.url)).toEqual([
      "/about",
      "/draft-ideas",
      "/long-title",
      "/work",
    ]);
    expect(
      pages.find((page) => page.url === "/draft-ideas")?.published_revision_id,
    ).toBeNull();

    const revisionCount = (await sql`
      SELECT count(*)::int AS n FROM cms_revisions r
      JOIN cms_pages p ON p.id = r.target_id WHERE p.url = '/work'
    `) as { n: number }[];
    expect(revisionCount[0].n).toBe(3);

    const title = (await sql`
      SELECT title FROM cms_pages WHERE url = '/long-title'
    `) as { title: string }[];
    expect(title[0].title).toBe(LONG_TITLE);
    expect(LONG_TITLE.length).toBe(200);

    const revoked = (await sql`
      SELECT count(*)::int AS n FROM cms_export_tokens WHERE revoked_at IS NOT NULL
    `) as { n: number }[];
    expect(revoked[0].n).toBe(1);

    // Every persona address is an @example.com one.
    for (const person of PERSONAS) {
      expect(person.email.endsWith("@example.com")).toBe(true);
    }
  });

  test("the banner publishes one link whose button text lives in the link", async () => {
    const blockTypes = (await sql`
      SELECT name, fields FROM cms_block_types
      WHERE name = 'banner'
    `) as {
      name: string;
      fields: {
        name: string;
        kind: string;
        label?: string;
        text?: boolean;
      }[];
    }[];

    // One link field and no separate text field: a plain link publishes no
    // `text` key at all, and the editor's Button text is the link's `label`.
    const fields = blockTypes[0]?.fields ?? [];
    expect(fields.map((field) => field.name)).toEqual(["link"]);
    expect(fields[0]?.kind).toBe("link");
    expect(fields[0]?.label).toBe("Button link");
    expect(fields[0]?.text).toBeUndefined();

    // The landing page type (what /about uses) allows it.
    const landing = (await sql`
      SELECT allowed_blocks FROM cms_page_types WHERE name = 'landing'
    `) as { allowed_blocks: string[] }[];
    expect(landing[0].allowed_blocks).toEqual(
      expect.arrayContaining(["banner"]),
    );
    expect(landing[0].allowed_blocks).not.toContain("banner-plain");

    // /about's published revision holds the banner with its words in the link.
    const published = (await sql`
      SELECT r.content FROM cms_revisions r
      JOIN cms_pages p ON p.id = r.target_id
      WHERE p.url = '/about' AND r.id = p.published_revision_id
    `) as {
      content: {
        blocks: {
          type: string;
          link?: { label?: string; pageId?: string };
        }[];
      };
    }[];
    const banners = published[0].content.blocks.filter(
      (block) => block.type === "banner",
    );
    expect(banners).toHaveLength(1);
    expect(banners[0]?.link?.label).toBe("Start a project");
    expect(banners[0]?.link?.pageId).toBeTruthy();
  });

  test("the site serves the published content and the local media", async () => {
    const about = await fetch(`${siteUrl}/about`);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain("About Northwind");

    const moved = await fetch(`${siteUrl}/our-work`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect((await fetch(`${siteUrl}/draft-ideas`)).status).toBe(404);

    const media = (await sql`
      SELECT variants FROM cms_media ORDER BY id LIMIT 1
    `) as { variants: { webpUrl: string }[] }[];
    const image = await fetch(media[0].variants[0].webpUrl);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(
      (await fetch(`${siteUrl}/media/..%2f..%2fpackage.json`)).status,
    ).toBe(404);
  });

  for (const person of PERSONAS.filter(
    (candidate) => candidate.role === "admin",
  )) {
    test(`${person.key}: the site cookie reaches the CMS handoff`, async () => {
      const printed = await cookieFor(person.key, "site");
      expect(printed.code).toBe(0);
      const response = await fetch(`${siteUrl}/cms/sign-in`, {
        redirect: "manual",
        headers: { Cookie: printed.stdout.trim() },
      });
      expect([302, 303]).toContain(response.status);
      expect(response.headers.get("location")).toStartWith(`${cmsUrl}/handoff`);
    });

    test(`${person.key}: the CMS cookie reaches the dashboard`, async () => {
      const printed = await cookieFor(person.key, "cms");
      expect(printed.code).toBe(0);
      const response = await fetch(`${cmsUrl}/cms`, {
        redirect: "manual",
        headers: { Cookie: printed.stdout.trim() },
      });
      expect(response.status).toBe(200);
    });
  }

  test("Tom is refused at sign-in and gets no handoff token", async () => {
    const printed = await cookieFor("tom", "site");
    expect(printed.code).toBe(0);
    const response = await fetch(`${siteUrl}/cms/sign-in`, {
      redirect: "manual",
      headers: { Cookie: printed.stdout.trim() },
    });
    expect(response.status).toBe(403);

    const tokens = (await sql`
      SELECT count(*)::int AS n FROM cms_handoff_tokens h
      JOIN users u ON u.id = h.user_id WHERE u.email = 'tom@example.com'
    `) as { n: number }[];
    expect(tokens[0].n).toBe(0);
  });

  test("Tom has no CMS session to print", async () => {
    const printed = await cookieFor("tom", "cms");
    expect(printed.code).not.toBe(0);
    expect(printed.stdout.trim()).toBe("");
    expect(printed.stderr).toContain("cms_identities");
  });
});
