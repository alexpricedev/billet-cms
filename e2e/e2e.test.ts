import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SQL } from "bun";
import { publish } from "../packages/billet-cms/src/cli/publish/index.ts";
import type { FieldMetadata } from "../packages/billet-cms/src/contract/index.ts";
import {
  CMS_SIGN_IN_PATH,
  type MediaVariant,
} from "../packages/billet-cms/src/contract/index.ts";
import {
  createCmsPages,
  createContentReader,
} from "../packages/billet-cms/src/server/index.ts";
import { siteDefinitions } from "./cms.config.ts";
import { createSite, type E2eSite } from "./site.ts";

/**
 * The end-to-end suite: the ticket's Done when, as an automated test.
 *
 * A fresh site publishes its definitions, an admin signs in to the CMS, edits a
 * slot's content and an image, previews the draft, publishes it, and sees it
 * live on the site — which keeps serving after the CMS process is stopped. The
 * CMS runs as a real subprocess; the site is a real `Bun.serve` on a real port.
 * Nothing here calls the CMS's services directly: the CMS is driven over HTTP,
 * as an editor's browser would.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the e2e suite");
}
const CRYPTO_PEPPER =
  process.env.CRYPTO_PEPPER || "e2e-pepper-do-not-use-in-production";

const VARIANTS: MediaVariant[] = [
  {
    width: 960,
    height: 540,
    webpKey: "e2e/960.webp",
    webpUrl: "https://bucket.example/e2e/960.webp",
    fallbackKey: "e2e/960.jpg",
    fallbackUrl: "https://bucket.example/e2e/960.jpg",
  },
  {
    width: 1920,
    height: 1080,
    webpKey: "e2e/1920.webp",
    webpUrl: "https://bucket.example/e2e/1920.webp",
    fallbackKey: "e2e/1920.jpg",
    fallbackUrl: "https://bucket.example/e2e/1920.jpg",
  },
];

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value of the first `<input name="…">`, HTML-unescaped. */
const attr = (html: string, name: string): string => {
  const match = html.match(
    new RegExp(`name="${escapeRegex(name)}" value="([^"]*)"`),
  );
  return match ? decodeHtml(match[1]) : "";
};

/** The CSRF token in the form whose `action` is exactly `action`. */
const csrfFor = (html: string, action: string): string => {
  const match = html.match(
    new RegExp(
      `action="${escapeRegex(action)}"[\\s\\S]*?name="_csrf" value="([^"]+)"`,
    ),
  );
  if (!match) throw new Error(`No CSRF token found for form ${action}`);
  return match[1];
};

const decodeHtml = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The value of `name` from a response's `Set-Cookie` headers. */
const cookieValue = (response: Response, name: string): string => {
  for (const header of response.headers.getSetCookie()) {
    const match = header.match(
      new RegExp(`(?:^|;\\s*)${escapeRegex(name)}=([^;]+)`),
    );
    if (match && match[1] !== "") return match[1];
  }
  throw new Error(`No ${name} cookie in the response`);
};

const pickFreePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve did not bind a port");
  return port;
};

interface Context {
  sql: SQL;
  site: E2eSite;
  siteServer: ReturnType<typeof Bun.serve>;
  siteUrl: string;
  cmsUrl: string;
  cms: Subprocess;
  cookie: string;
  slotId: string;
  mediaId: string;
}

let ctx: Context;

const cmsFetch = (
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> =>
  fetch(`${ctx.cmsUrl}${path}`, {
    redirect: "manual",
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookie ? { Cookie: `session_id=${cookie}` } : {}),
    },
  });

beforeAll(async () => {
  const sql = new SQL(DATABASE_URL, { max: 5 });

  // The site's own users table has to exist before the CMS boots: it creates the
  // `cms_identities` view over `users` only when the table is already there.
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      role VARCHAR(20) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin'))
    )
  `;

  // A real site server, on a real port. It knows the CMS's origin so its
  // `/cms/sign-in` route can hand an editor to the right CMS (a real site reads
  // this from `CMS_URL`).
  const cmsPort = pickFreePort();
  const cmsUrl = `http://localhost:${cmsPort}`;

  const site = createSite(sql, { cmsUrl });
  const siteServer = Bun.serve({
    port: 0,
    fetch: (req) => site.handler(req),
  });
  const siteUrl = `http://localhost:${siteServer.port}`;

  const cms = Bun.spawn({
    cmd: ["bun", "--no-env-file", "run", "src/server/main.ts"],
    cwd: join(import.meta.dir, "..", "app"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL,
      CRYPTO_PEPPER,
      PORT: String(cmsPort),
      APP_NAME: "Billet CMS",
      APP_URL: cmsUrl,
      SITE_APP_URL: siteUrl,
      SESSION_COOKIE_NAME: "session_id",
    },
    stdout: "ignore",
    stderr: "inherit",
  });

  ctx = {
    sql,
    site,
    siteServer,
    siteUrl,
    cmsUrl,
    cms,
    cookie: "",
    slotId: "",
    mediaId: "",
  };

  // Wait for the CMS to migrate and listen.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${cmsUrl}/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        "The CMS did not start in time. Its logs are printed above.",
      );
    }
    await Bun.sleep(100);
  }

  // A clean slate, and the site admin the CMS will sign in.
  await sql`
    TRUNCATE TABLE
      cms_audit, cms_export_tokens,
      cms_media, cms_redirects, cms_pages,
      cms_preview_tokens, cms_handoff_tokens, cms_revisions,
      cms_user_tokens, cms_sessions,
      cms_block_types, cms_page_types, cms_slots
    RESTART IDENTITY CASCADE
  `;
  await sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`;
  await sql`UPDATE cms_meta SET content_version = 0 WHERE id = 1`;

  await sql`
    INSERT INTO users (email, role) VALUES ('admin@example.com', 'admin')
  `;

  // Deploy: publish the site's declarations the way `cms:publish` does.
  const summary = await publish(sql, siteDefinitions);
  // Counted from the declarations rather than pinned, so adding one to the
  // site's vocabulary is not a failure here about something else.
  expect(summary.blocks).toBe(siteDefinitions.blocks.length);
  expect(summary.slots).toBe(siteDefinitions.slots.length);
  expect(summary.pageTypes).toBe(siteDefinitions.pageTypes.length);

  // A `group` has to survive the trip through JSONB, not just the unit tests:
  // the CMS builds its form from this row and never imports site code, so a
  // nested field the publish step flattened wrongly would be a control that
  // never renders.
  const [stepsType] = (await sql`
    SELECT fields, json_schema FROM cms_block_types WHERE name = 'steps'
  `) as { fields: FieldMetadata[]; json_schema: Record<string, unknown> }[];
  const items = stepsType.fields.find((field) => field.name === "items");
  expect(items?.kind).toBe("list");
  expect(items?.of?.kind).toBe("group");
  expect(items?.of?.fields?.map((field) => field.name)).toEqual([
    "title",
    "body",
  ]);

  const slots = (await sql`
    SELECT id FROM cms_slots WHERE name = 'home.hero'
  `) as { id: string }[];
  ctx.slotId = slots[0].id;

  // An image the editor can reference. Uploads need a bucket; seeding the row
  // directly stands in for the upload and gives `<CmsImage>` its renditions.
  const media = (await sql`
    INSERT INTO cms_media
      (object_key, content_type, byte_size, width, height, alt, variants)
    VALUES (
      'e2e/original.webp', 'image/webp', 4096, 1920, 1080, 'An e2e field',
      ${VARIANTS}
    )
    RETURNING id
  `) as { id: string }[];
  ctx.mediaId = media[0].id;

  // Sign the admin in the way a real editor arrives: signed out at the CMS,
  // which hands the browser to the site's `/cms/sign-in` route; nobody is signed
  // in on the site yet, so that route goes through the site's own login and
  // back, then mints a single-use handoff token the CMS spends. Nothing here
  // writes a `cms_handoff_tokens` row itself: the site route mints it through
  // the plugin, exactly as it does for a real editor.
  const toSite = await fetch(`${cmsUrl}/sign-in`, { redirect: "manual" });
  expect(toSite.status).toBe(303);
  const siteSignIn = new URL(toSite.headers.get("location") as string);
  expect(siteSignIn.origin).toBe(siteUrl);
  expect(siteSignIn.pathname).toBe(CMS_SIGN_IN_PATH);

  // Signed out on the site: the sign-in route sends the editor through the
  // site's own login first, and back afterwards.
  const toLogin = await fetch(siteSignIn, { redirect: "manual" });
  expect(toLogin.status).toBe(303);
  const login = new URL(toLogin.headers.get("location") as string, siteUrl);
  expect(login.origin).toBe(siteUrl);
  expect(login.pathname).toBe("/login");

  const loginForm = await fetch(login);
  expect(loginForm.status).toBe(200);

  const signedIn = await fetch(`${siteUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "admin@example.com",
      next: login.searchParams.get("next") ?? "",
    }),
  });
  expect(signedIn.status).toBe(303);
  const siteSession = cookieValue(signedIn, "site_session");

  // Back at the site's sign-in route, now signed in: the plugin checks
  // `cms_identities` and mints the handoff token, and the site sends the browser
  // to the CMS.
  const toHandoff = await fetch(siteSignIn, {
    redirect: "manual",
    headers: { Cookie: `site_session=${siteSession}` },
  });
  expect(toHandoff.status).toBe(303);
  const handoff = new URL(toHandoff.headers.get("location") as string);
  expect(handoff.origin).toBe(cmsUrl);
  expect(handoff.pathname).toBe("/handoff");
  const rawToken = handoff.searchParams.get("token");
  if (!rawToken) throw new Error("The site's sign-in route minted no token");

  // The CMS shows a confirm step (so a scanner can't spend the token) and
  // spends it on POST.
  const confirm = await fetch(handoff, { redirect: "manual" });
  const confirmHtml = await confirm.text();
  const guest = cookieValue(confirm, "session_id");
  const handoffCsrf = confirmHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!handoffCsrf) throw new Error("No CSRF token on the handoff page");

  const spent = await fetch(`${cmsUrl}/handoff`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: cmsUrl,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `session_id=${guest}`,
    },
    body: new URLSearchParams({ _csrf: handoffCsrf, token: rawToken }),
  });
  expect(spent.status).toBe(303);
  ctx.cookie = cookieValue(spent, "session_id");
}, 60_000);

afterAll(async () => {
  ctx.cms.kill();
  await ctx.cms.exited;
  ctx.siteServer.stop(true);
  await ctx.sql.end();
});

/** GET the slot editor page and pull out the three CSRF tokens it carries. */
const openSlotForm = async (): Promise<{
  html: string;
  saveCsrf: string;
  publishCsrf: string;
  previewCsrf: string;
  baseRevision: string;
  latestRevision: string;
}> => {
  const response = await cmsFetch(`/cms/slots/${ctx.slotId}`, {}, ctx.cookie);
  expect(response.status).toBe(200);
  const html = await response.text();
  return {
    html,
    saveCsrf: csrfFor(html, `/cms/slots/${ctx.slotId}`),
    publishCsrf: csrfFor(html, `/cms/slots/${ctx.slotId}/publish`),
    previewCsrf: csrfFor(html, `/cms/slots/${ctx.slotId}/preview`),
    baseRevision: attr(html, "base_revision"),
    latestRevision: attr(html, "revision"),
  };
};

/** Save a draft with the given heading. */
const saveDraft = async (heading: string): Promise<void> => {
  const form = await openSlotForm();
  const response = await cmsFetch(
    `/cms/slots/${ctx.slotId}`,
    {
      method: "POST",
      headers: {
        Origin: ctx.cmsUrl,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: form.saveCsrf,
        base_revision: form.baseRevision,
        content: JSON.stringify({
          heading,
          photo: { mediaId: ctx.mediaId, alt: "An e2e field" },
        }),
      }),
    },
    ctx.cookie,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    `/cms/slots/${ctx.slotId}?saved=1`,
  );
};

/** Publish the newest draft through the CMS's publish endpoint. */
const publishLatest = async (): Promise<void> => {
  const form = await openSlotForm();
  expect(form.latestRevision).not.toBe("");
  const response = await cmsFetch(
    `/cms/slots/${ctx.slotId}/publish`,
    {
      method: "POST",
      headers: {
        Origin: ctx.cmsUrl,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: form.publishCsrf,
        revision: form.latestRevision,
      }),
    },
    ctx.cookie,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    `/cms/slots/${ctx.slotId}?published=1`,
  );
};

const siteHtml = async (path = "/"): Promise<string> => {
  const response = await fetch(`${ctx.siteUrl}${path}`);
  expect(response.status).toBe(200);
  return await response.text();
};

describe("the ticket's Done when, end to end", () => {
  test("the CMS signs the admin in and builds a form from the published block", async () => {
    const form = await openSlotForm();
    // The form is generated from the block type's published metadata.
    expect(form.html).toContain("Home hero");
    expect(form.html).toContain("Heading");
    expect(form.html).toContain('name="content"');
    expect(form.html).toContain("Photo");
  }, 30_000);

  test("an editor saves content and an image, previews the draft, publishes, and the site renders it", async () => {
    // 1. Save and publish a first draft.
    await saveDraft("Published heading");
    await publishLatest();
    ctx.site.invalidate();
    const live = await siteHtml();
    expect(live).toContain("Published heading");
    expect(live).toContain("https://bucket.example/e2e/1920.jpg");

    // 2. Save a newer draft; the site still shows the published one.
    await saveDraft("Draft heading");
    ctx.site.invalidate();
    expect(await siteHtml()).toContain("Published heading");

    // 3. Preview the draft: a token row, opened as a real site URL.
    const form = await openSlotForm();
    const preview = await cmsFetch(
      `/cms/slots/${ctx.slotId}/preview`,
      {
        method: "POST",
        headers: {
          Origin: ctx.cmsUrl,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: form.previewCsrf }),
      },
      ctx.cookie,
    );
    expect(preview.status).toBe(303);
    const location = preview.headers.get("location");
    expect(location).toContain(`${ctx.siteUrl}/?cms_preview=`);

    const previewed = await fetch(location as string);
    expect(previewed.status).toBe(200);
    expect(previewed.headers.get("cache-control")).toBe("no-store");
    const previewHtml = await previewed.text();
    expect(previewHtml).toContain("Draft heading");
    expect(previewHtml).toContain("showing unpublished draft content");

    // 4. Publish the draft; the site picks it up.
    await publishLatest();
    ctx.site.invalidate();
    expect(await siteHtml()).toContain("Draft heading");
  }, 30_000);

  test("a cold slot costs one version read and one joined query on real Postgres", async () => {
    // Wrap the real pool to count what the reader asks it for. A fresh reader
    // has no cached version, so this is the cold path straight after a publish.
    let queries = 0;
    const counting = new Proxy(ctx.sql, {
      get(target, property, receiver) {
        if (property === "unsafe") {
          return (query: string, params?: unknown[]) => {
            queries += 1;
            return (
              target.unsafe as (q: string, p?: unknown[]) => Promise<unknown>
            ).call(target, query, params);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SQL;

    const reader = createContentReader({ sql: counting, onSkip: () => {} });
    const content = await reader.getSlot("home.hero");
    expect(content).not.toBeNull();
    // One version read and one slot query — not the three queries a cold slot
    // used to cost (slot, block type, revision).
    expect(queries).toBe(2);

    // Warm: the cached slot and the throttled version cost nothing.
    await reader.getSlot("home.hero");
    expect(queries).toBe(2);
  });

  test("the readers share one version poll, and invalidate() forces it to re-read", async () => {
    // Count `cms_meta` reads on the real pool: the slot, page and media readers
    // built without a custom clock share one poll per pool.
    let versionReads = 0;
    const counting = new Proxy(ctx.sql, {
      get(target, property, receiver) {
        if (property === "unsafe") {
          return (query: string, params?: unknown[]) => {
            if (query.includes("cms_meta")) versionReads += 1;
            return (
              target.unsafe as (q: string, p?: unknown[]) => Promise<unknown>
            ).call(target, query, params);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SQL;

    const slots = createContentReader({ sql: counting, onSkip: () => {} });
    const pages = createCmsPages({ sql: counting, onSkip: () => {} });

    expect(await slots.getSlot("home.hero")).not.toBeNull();
    // `getPage` shares the slot reader's poll: it must not read the version a
    // second time.
    await pages.getPage("/");
    expect(versionReads).toBe(1);

    // A hard reset on either reader forces the shared poll to re-read at once —
    // inside the interval a fresh poll would have skipped until.
    slots.invalidate();
    await pages.getPage("/");
    expect(versionReads).toBe(2);
  });

  // r1-2: invalidate() has to reset the media reader as well as the slot one. A
  // media-only change does not move `content_version` (only a publish does), so
  // without the media reset the site would keep rendering the media it cached.
  test("invalidate() drops the media reader's cache too, not just the slot's", async () => {
    // Warm the site's slot and media caches through the live site.
    expect(await siteHtml()).toContain("https://bucket.example/e2e/1920.jpg");

    // Change the media row out of band: the renditions point somewhere else,
    // and `content_version` deliberately does not move.
    const changed = VARIANTS.map((variant) => ({
      ...variant,
      webpKey: variant.webpKey.replace("e2e/", "changed/"),
      fallbackKey: variant.fallbackKey.replace("e2e/", "changed/"),
      webpUrl: variant.webpUrl.replace("bucket.example", "changed.example"),
      fallbackUrl: variant.fallbackUrl.replace(
        "bucket.example",
        "changed.example",
      ),
    }));
    await ctx.sql`
      UPDATE cms_media SET variants = ${changed} WHERE id = ${ctx.mediaId}
    `;

    // A hard reset must drop the media reader's entry, not only the slot's.
    ctx.site.invalidate();
    expect(await siteHtml()).toContain("https://changed.example/e2e/1920.jpg");

    // Restore for the tests after this one.
    await ctx.sql`
      UPDATE cms_media SET variants = ${VARIANTS} WHERE id = ${ctx.mediaId}
    `;
    ctx.site.invalidate();
    expect(await siteHtml()).toContain("https://bucket.example/e2e/1920.jpg");
  });

  test("the site keeps serving after the CMS is stopped", async () => {
    ctx.cms.kill();
    await ctx.cms.exited;

    // No process is listening on the CMS port any more.
    await expect(fetch(`${ctx.cmsUrl}/health`)).rejects.toThrow();

    const html = await siteHtml();
    expect(html).toContain("Draft heading");
    expect(html).toContain("https://bucket.example/e2e/1920.jpg");
  }, 30_000);
});
