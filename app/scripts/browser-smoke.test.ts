import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { block, list, richText, text } from "@alexpricedev/billet-cms/fields";
import { createEditContentLink } from "@alexpricedev/billet-cms/handoff";
import { handleCmsSignIn } from "@alexpricedev/billet-cms/sign-in";
import type { Subprocess } from "bun";
import { SQL } from "bun";
import { seedBlockType, seedSlot } from "../src/server/test-utils/content";
import {
  cleanupTestData,
  seedIdentity,
} from "../src/server/test-utils/helpers";
import { prepareDatabase } from "../src/server/test-utils/prepare-databases";

// Real-browser smoke tests, run via `bun run test:browser` — deliberately NOT
// part of `bun run test`, which globs `src` only. Bun.WebView is experimental
// and the engine differs by platform, so these journeys must never gate the
// deterministic suite. The `chrome` backend is required off macOS (the default
// `webkit` backend throws there) and is what CI installs, so every run is
// pinned to it rather than to whatever the platform defaults to. What they
// cover is exactly what happy-dom can't:
//
// - the client bundle executing in a real page (running, not just parsing)
// - CSP: a blocked script passes every unit test and fails only here
// - the *sign-in* journey, which crosses two origins: a signed-out CMS visit
//   leaves for the site's sign-in route, comes back to the CMS's `/handoff`
//   with a single-use token, and only then is a `cms_session` live. The unit
//   tests drive both halves in-process; only a real browser proves the
//   cookies, redirects and CSRF round-trip survive the hop.
//
// Two real subprocesses run against the test database: the CMS itself, and a
// minimal site that mounts the plugin's `handleCmsSignIn` and an Edit content
// link. Everything the CMS needs from a site is the route and the shared
// database, so that is all the stand-in provides.

const CMS_PORT = 3987;
const SITE_PORT = 3988;
const CMS_BASE = `http://localhost:${CMS_PORT}`;
const SITE_BASE = `http://localhost:${SITE_PORT}`;
const SCREENSHOT_DIR = "/tmp/billet-browser-smoke";

let sql: SQL;
let server: Subprocess;
let site: ReturnType<typeof Bun.serve> | undefined;
let view: InstanceType<typeof Bun.WebView>;

// The site user the Edit content link and the site's sign-in both act as.
let adminId = "";
// The slot whose generated form proves the CMS form script runs.
let slotId = "";

// Everything the CMS prints, accumulated as it arrives.
let serverLog = "";

// Every page-side console.error lands here; the last test asserts the run was
// clean. CSP violations report through the page console, which is the whole
// reason to collect them.
const pageErrors: string[] = [];

/** Poll `fn` until `pred` accepts its result or the deadline passes. */
const until = async <T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  ms = 15_000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await Bun.sleep(100);
    last = await fn();
  }
  return last;
};

/**
 * Body text, tolerant of an in-flight navigation: WebKit rejects an evaluate
 * whose page goes away mid-call ("completion handler no longer reachable"),
 * which is the normal state right after clicking a submit button. Poll through
 * it — the next attempt lands on the new page.
 */
const bodyText = (): Promise<string> =>
  view.evaluate<string>("document.body.innerText").catch(() => "");

/**
 * Click something that navigates. The navigation itself can tear down the
 * click's completion handler (same WebKit behaviour as above), and the
 * navigation is the outcome the caller polls for — so a lost handler is not
 * a failure.
 */
const clickThrough = (selector: string): Promise<void> =>
  view.click(selector).catch(() => {});

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const siteHtml = (body: string): Response =>
  new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
      `<link rel="icon" href="data:,"><title>Test site</title></head>` +
      `<body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/**
 * The site's own session: a cookie the site's login set. The plugin's sign-in
 * route resolves the site user through this, the way a real site wires it to
 * its own session lookup.
 */
const siteUserId = (req: Request): string | null => {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)site_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

/** The site's home, carrying the Edit content link the plugin helper mints. */
const siteHome = async (): Promise<Response> => {
  const link = adminId
    ? await createEditContentLink(sql, { userId: adminId, cmsUrl: CMS_BASE })
    : null;

  return siteHtml(
    link
      ? `<h1>Test site</h1><a class="edit-content" href="${link}">Edit content</a>`
      : "<h1>Test site</h1><p>Signed out</p>",
  );
};

/** The site's login: a form, like a real site's own sign-in page. */
const siteLogin = (next: string): Response =>
  siteHtml(
    "<h1>Sign in to the site</h1>" +
      `<form method="post" action="/login">` +
      `<input type="hidden" name="next" value="${escapeHtml(next)}">` +
      `<button type="submit" class="site-login-submit">Sign in</button>` +
      "</form>",
  );

const startSite = (): void => {
  site = Bun.serve({
    port: SITE_PORT,
    routes: {
      "/": siteHome,
      "/login": {
        GET: (req) =>
          siteLogin(new URL(req.url).searchParams.get("next") ?? "/"),
        POST: async (req) => {
          const form = await req.formData();
          const submitted = String(form.get("next") ?? "/");
          // A relative `next` only, so the fake login can't be pointed at
          // another host.
          const next = submitted.startsWith("/") ? submitted : "/";
          return new Response("", {
            status: 303,
            headers: {
              Location: next,
              "Set-Cookie": `site_session=${encodeURIComponent(adminId)}; Path=/; HttpOnly; SameSite=Lax`,
            },
          });
        },
      },
      // The route the plugin mounts on a real site: it checks the site user
      // against `cms_identities` and mints the handoff token the CMS spends.
      "/cms/sign-in": (req) =>
        handleCmsSignIn(req, { sql, cmsUrl: CMS_BASE, getUserId: siteUserId }),
    },
  });
};

// The block and slot the CMS builds a form from. The list gives the page
// script something to do (Add appends a row) and the text field something to
// type into, so a save proves the script rebuilt the hidden content field.
const hero = block(
  "hero",
  {
    heading: text({ label: "Heading", max: 80 }),
    body: richText({ label: "Body", required: false }),
    tags: list(text({ label: "Tag" }), { label: "Tags", max: 5 }),
  },
  () => null,
);

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required (run via bun run test:browser)");
  }

  sql = new SQL(process.env.DATABASE_URL, { max: 3 });

  // Make the database look like a site the CMS reads: the site's `users` table
  // and the `cms_identities` view over it. The CMS's own tables are created by
  // the server's boot migrations below.
  await prepareDatabase(sql);

  // The CMS, as a real subprocess against the test database. Its boot also runs
  // the migrations, so this exercises boot and — on teardown — the SIGTERM
  // drain. It gets its own port and matching APP_URL (CSRF origin validation
  // compares them exactly) and points at the stand-in site for sign-in.
  server = Bun.spawn(["bun", "src/server/main.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(CMS_PORT),
      APP_URL: CMS_BASE,
      SITE_APP_URL: SITE_BASE,
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of server.stdout as ReadableStream<Uint8Array>) {
      serverLog += decoder.decode(chunk);
    }
  })();

  // Bun.fetch, not fetch: the happy-dom preload replaces global fetch with
  // one that enforces the Same Origin Policy against its fake window.
  const ready = await until(
    () =>
      Bun.fetch(CMS_BASE)
        .then((res) => res.ok)
        .catch(() => false),
    (ok) => ok === true,
    20_000,
  );
  if (!ready)
    throw new Error(`Server did not answer on ${CMS_BASE}\n${serverLog}`);

  // A clean slate on the tables the CMS owns, then the site user and the block
  // and slot the journeys act on. The site's `users` table is truncated by
  // `cleanupTestData`, guarded by an existence check.
  await cleanupTestData(sql);
  adminId = (await seedIdentity(sql, "editor@example.com")).id;
  await seedBlockType(sql, hero);
  slotId = await seedSlot(sql, {
    name: "home.hero",
    blockName: "hero",
    page: "home",
    label: "Hero",
  });

  startSite();

  view = new Bun.WebView({
    // Chrome, not the platform default: `webkit` (the default) throws on
    // non-macOS, and CI is Linux. Pinning it means local and CI run the same
    // engine. Bun auto-detects the binary, or takes BUN_CHROME_PATH when CI's
    // setup-chrome sets it.
    backend: "chrome",
    width: 1280,
    height: 900,
    console: (type, ...args) => {
      if (type === "error") pageErrors.push(args.map(String).join(" "));
    },
  });
});

afterAll(async () => {
  view?.close();
  site?.stop(true);
  // SIGTERM, not kill(): teardown doubles as a live check of the graceful
  // shutdown handler. A hang here means the drain regressed.
  server?.kill("SIGTERM");
  await server?.exited;
  await sql?.end();
});

describe("browser smoke", () => {
  test("home renders with a title and an applied stylesheet", async () => {
    await view.navigate(`${CMS_BASE}/`);

    const title = await view.evaluate<string>("document.title");
    expect(title.length).toBeGreaterThan(0);

    // A missing or CSP-blocked stylesheet leaves styleSheets empty while the
    // HTML still renders — the classic "passes every test, unstyled in prod".
    const styleSheets = await view.evaluate<number>(
      "document.styleSheets.length",
    );
    expect(styleSheets).toBeGreaterThan(0);
  });

  test("the client bundle runs the forms page script", async () => {
    await view.navigate(`${CMS_BASE}/forms`);

    // set only by src/client/pages/forms.ts at init — proves main.js was
    // served, passed CSP, executed, and the page registry dispatched.
    const validationMessage = await until(
      () =>
        view.evaluate<string>(
          `document.querySelector("input[name='name']")?.validationMessage ?? ""`,
        ),
      (msg) => msg.length > 0,
    );
    expect(validationMessage).toBe("Oi, enter your name.");
  });

  test("a guest submits the form through the CSRF round-trip", async () => {
    await view.navigate(`${CMS_BASE}/forms`);

    await view.click("input[name='name']");
    await view.type("Smoke Tester");
    await view.click("textarea[name='message']");
    await view.type("Filed by the browser smoke test.");
    await clickThrough(".form-card button[type='submit']");

    // The POST redirects back to /forms with the flash cookie set.
    const flash = await until(bodyText, (text) =>
      text.includes("Submitted successfully"),
    );
    expect(flash).toContain("Submitted successfully");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await Bun.write(
      `${SCREENSHOT_DIR}/forms-success.png`,
      await view.screenshot(),
    );
  });

  test("a signed-out CMS visit signs in through the site and back", async () => {
    // No cookie yet: /cms answers a redirect chain out to the site's sign-in
    // route and then to the site's own login.
    await view.navigate(`${CMS_BASE}/cms`);

    const loginUrl = await until(
      async () => view.url,
      (url) => url.includes("/login?next="),
    );
    expect(decodeURIComponent(loginUrl)).toContain("next=/cms/sign-in");

    // The site's login runs first (password or magic link — the CMS doesn't
    // care), then its /cms/sign-in route mints the handoff token.
    await clickThrough("button.site-login-submit");

    // Back on the CMS's confirm step. The GET only shows the button; the POST
    // spends the token. Wait on the subtitle: the site's own page carries an
    // "Edit content" link, so the heading alone matches before the hop.
    const confirm = await until(bodyText, (text) =>
      text.includes("You'll be signed in to Billet CMS"),
    );
    expect(confirm).toContain("Edit content");

    await clickThrough("form button.login-submit");

    const signedIn = await until(bodyText, (text) => text.includes("Sign out"));
    expect(signedIn).toContain("Content");
    expect(signedIn).toContain("Hero");

    // `view.url` can lag a form POST redirect in Bun.WebView, so read the live
    // document location instead.
    const url = await view.evaluate<string>("location.href");
    expect(url.startsWith(`${CMS_BASE}/cms`)).toBe(true);
  });

  test("the CMS form script rebuilds the content field on save", async () => {
    // Continues signed in from the journey above.
    await view.navigate(`${CMS_BASE}/cms/slots/${slotId}`);

    // The server rendered one empty list row; the client script appends a
    // second on click. That only happens if cms-form.js loaded, passed CSP and
    // ran — the same proof the forms page gives for main.js.
    const rowCount = () =>
      view.evaluate<number>(
        `document.querySelectorAll("[data-list-items] > [data-list-item]").length`,
      );
    const before = await rowCount();
    await view.click("[data-list-add]");
    // Bun's Chrome backend can leave a click's completion handler pending, and
    // a `evaluate` issued straight after stalls behind it. A beat, then read.
    await Bun.sleep(300);
    expect(await rowCount()).toBe(before + 1);

    // Save a heading. The input has no `name`: only the hidden `content` field
    // is submitted, and only the script rebuilds it from the inputs, so a saved
    // heading proves the script ran on submit too. `requestSubmit()` fires the
    // same submit event a click would — the script's listener included — without
    // waiting on a click's navigation, which stalls the same way.
    await view.click("#cms-field-heading");
    await view.type("Hero heading from the smoke test");
    await Bun.sleep(300);
    await view
      .evaluate(`document.querySelector("form[data-cms-form]").requestSubmit()`)
      .catch(() => {});

    const saved = await until(bodyText, (text) =>
      text.includes("Draft saved."),
    );
    expect(saved).toContain("Draft saved.");
  });

  test("the Edit content link signs in through /handoff", async () => {
    // Sign out first: /handoff sends an already-signed-in visitor straight to
    // /cms, so the token would never be spent.
    await view.navigate(`${CMS_BASE}/cms`);
    await clickThrough("form[action='/auth/logout'] button");
    await until(bodyText, (text) => text.includes("Sign in"));

    // The site's home renders the link from the plugin helper — same token
    // mechanism, minted by the site and spent by the CMS.
    await view.navigate(`${SITE_BASE}/`);
    const href = await view.evaluate<string>(
      `document.querySelector("a.edit-content")?.getAttribute("href") ?? ""`,
    );
    expect(href.startsWith(`${CMS_BASE}/handoff?token=`)).toBe(true);

    await clickThrough("a.edit-content");
    const handoffUrl = await until(
      async () => view.url,
      (url) => url.includes("/handoff?token="),
    );
    expect(handoffUrl).toContain(`${CMS_BASE}/handoff?token=`);

    const confirm = await until(bodyText, (text) =>
      text.includes("You'll be signed in to Billet CMS"),
    );
    expect(confirm).toContain("Edit content");

    await clickThrough("form button.login-submit");
    const signedIn = await until(bodyText, (text) => text.includes("Sign out"));
    expect(signedIn).toContain("Content");

    // `view.url` can lag the form POST above, so read the live document.
    const url = await view.evaluate<string>("location.href");
    expect(url.startsWith(`${CMS_BASE}/cms`)).toBe(true);
  });

  test("no page threw or hit a CSP violation across the run", () => {
    expect(pageErrors).toEqual([]);
  });
});
