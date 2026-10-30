import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// The guardrails on client code, as a test rather than a paragraph. Billet's
// client has three tiers — plain forms with redirects, forms enhanced with a
// server-rendered fragment, and presentation over rows already on the page —
// and everything below is what stops a fourth tier appearing: a client that
// fetches JSON, builds its own markup, and holds domain state. See CLAUDE.md,
// "Client code has three tiers". Raise a budget or add an exemption only with
// the reason written next to it.

const CLIENT = "src/client";
const SERVER = "src/server";

// The places the client talks to the server and parses what comes back. The
// request helper is the enhanced-form protocol; the image picker is the third
// recorded exception (AGENTS.md) — a library grid, alt search, paging and a
// drop zone cannot be a server-rendered form. It is confined to the two media
// routes and builds every tile with createElement/textContent.
const NETWORK_AND_MARKUP_ALLOWED = new Set([
  `${CLIENT}/reactive/request.ts`,
  `${CLIENT}/image-picker.ts`,
]);

// Minified bytes for the main entry point. It is 5,292 bytes (5.17 KiB) at the
// time of writing, and an application component costs 1–2 KiB — contact-directory
// and a two-part comment thread, built to test this layer, cost 1.6 KiB and
// 2.2 KiB.
//
// So the headroom is the number that matters, not the ceiling: 16,000 bytes
// (15.6 KiB) leaves room for roughly five more components at that size before a
// deliberate decision is needed. It was 12,000 bytes when main.js was about
// 9.1 KB, which sounds generous but left room for barely one more component,
// and the next one tripped a failure message accusing code that was doing
// exactly what this layer is for. Raise it again only with the same arithmetic
// written down — the number moving is the signal that something is being built
// on the client that belongs on the server.
const MAIN_BUNDLE_BUDGET_BYTES = 16_000;

// Minified bytes for the block editor, `cms-form.ts`. It is 12,840 bytes
// (12.54 KiB) at the time of writing, after the shared image picker replaced the
// reuse `<select>`, its options template and the image-field handlers. This is the one recorded exception to "the
// client is presentation only" (AGENTS.md): a contenteditable rich-text field,
// repeatable rows and the media focal picker need client JS, and the script is
// kept to walking the server-rendered DOM back into the hidden `content` field.
// 14,000 bytes leaves room for a small editor feature before a deliberate
// decision is needed — the same arithmetic as the main bundle above, and the
// number moving is the signal that the editor is growing into an application.
// It was 12,000 when the bundle was 9,803; the editor has since added the page
// block controls (move, remove, the Add-limit state) and the "no blocks yet"
// toggle, which is the tier-3 work this budget is meant to accommodate rather
// than the start of an application.
//
// The last rise, 13,500 → 14,000, is the link field's fixes: dropping New tab
// for Email and Phone, compacting the phone number's spaces to the `tel:`
// allowlist, keeping a page link that has only hover text, and re-naming the
// radios in a cloned list row so two rows are not one browser radio group. It
// measured 13,863, so the old budget had no room for this. Raise it again only
// with the same arithmetic written down.
//
// The rise 14,000 → 14,300 was the long text field: a `max` over 120 renders a
// textarea, and the client collapses pasted line breaks to single spaces on
// save, counts it like the input, grows it on first paint and as the editor
// types (including in cloned list rows and blocks), and keeps Enter from adding
// a break. It measured 14,133.
//
// This rise, 14,300 → 14,600, is the review of that work: a box with no layout
// (in a collapsed `<details>`) is left un-grown instead of being pinned to zero
// height; a ResizeObserver re-grows it when its width changes, so a narrowed
// window, a rotated phone or a late web font re-wraps to a taller box; and the
// live counter counts the same collapsed string the save stores. It measures
// 14,509, so the old budget had no room for this. 14,600 keeps a few lines'
// headroom; the number moving is still the signal, so raise it again only with
// the same arithmetic written down.
const CMS_FORM_BUNDLE_BUDGET_BYTES = 14_600;

// Minified bytes for the shared image picker, `image-picker.ts`. It is 9,404
// bytes (9.18 KiB) at the time of writing.
//
// This is the third recorded exception (AGENTS.md): the picker has to read the
// options route, upload with progress and build tiles from JSON, which no
// server-rendered form can do. The budget is a fence around that job, not room
// to grow: it holds the modal, focus trap, paging, search, drop zone and the
// closed-field update and nothing else. Using it for block `image` fields added
// the too-narrow warning (the picker knows the chosen width) and binding for
// pickers cloned into list rows after load, which took it from 7,912 to 9,404.
// 10,000 bytes still holds, but the headroom is now one small fix: raising it
// is the signal to ask whether a feature belongs in the picker or in the server
// that renders the field. See `image-picker.test.ts` for what the client is
// expected to do.
const IMAGE_PICKER_BUNDLE_BUDGET_BYTES = 10_000;

const sources = (root: string): string[] =>
  Array.from(new Glob("**/*.{ts,tsx}").scanSync(root))
    .filter((file) => !file.includes(".test.") && !file.includes("test-utils"))
    .map((file) => `${root}/${file}`)
    .sort();

type Rule = { name: string; pattern: RegExp; why: string };

const FORBIDDEN_IN_CLIENT: Rule[] = [
  {
    name: "network",
    pattern: /\bfetch\(|XMLHttpRequest|new WebSocket|new EventSource/,
    why: "the client talks to the server through server.submit, and the server answers with HTML",
  },
  {
    name: "markup built on the client",
    pattern:
      /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|DOMParser|createElement\(\s*["']template["']/,
    why: "the server renders every piece of markup; the client inserts what it was sent",
  },
  {
    name: "JSON consumed by the page",
    pattern: /JSON\.parse\(/,
    why: "the JSON API is for machines; a page reading it is a client application",
  },
  {
    name: "client routing",
    pattern:
      /history\.(pushState|replaceState)|location\.(assign|replace)\(|location\.href\s*=/,
    why: "navigation is a link or a server redirect",
  },
  {
    name: "client storage",
    pattern: /localStorage|sessionStorage|indexedDB/,
    why: "state lives on the server; signals hold interface state for one page view",
  },
];

// One import statement per match: a line starting with `import`, up to the
// first semicolon — anchored to the line start so the word in a comment doesn't
// swallow the code after it. Type-only imports are erased and cross freely.
const importStatements = (source: string): string[] =>
  source.match(/^import\s[^;]*;/gm) ?? [];

const isTypeOnly = (statement: string): boolean =>
  /^import\s+type\b/.test(statement);

describe("client boundaries", () => {
  const clientFiles = sources(CLIENT);
  const serverFiles = sources(SERVER);

  test("client code has files to check", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(serverFiles.length).toBeGreaterThan(0);
  });

  for (const rule of FORBIDDEN_IN_CLIENT) {
    test(`no ${rule.name} outside the request helper`, async () => {
      const offenders: string[] = [];
      for (const file of clientFiles) {
        if (NETWORK_AND_MARKUP_ALLOWED.has(file)) continue;
        const source = await Bun.file(file).text();
        const match = source.match(rule.pattern);
        if (match) offenders.push(`${file}: ${match[0]}`);
      }
      expect(offenders, `${rule.name} in client code — ${rule.why}`).toEqual(
        [],
      );
    });
  }

  test("client code imports nothing from the server at runtime", async () => {
    const offenders: string[] = [];
    for (const file of clientFiles) {
      const source = await Bun.file(file).text();
      for (const statement of importStatements(source)) {
        if (isTypeOnly(statement)) continue;
        if (/from\s+["'](@server\/|(\.\.\/)+server\/)/.test(statement)) {
          offenders.push(`${file}: ${statement.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("server code imports nothing from the client at runtime", async () => {
    // Types cross freely — that is how templates typecheck their binding
    // names. Runtime imports of client code would put DOM code in the server
    // process; `src/shared/` is where code both sides run belongs.
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const source = await Bun.file(file).text();
      for (const statement of importStatements(source)) {
        if (isTypeOnly(statement)) continue;
        if (/from\s+["'](@client\/|(\.\.\/)+client\/)/.test(statement)) {
          offenders.push(`${file}: ${statement.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("shared code has no DOM or Node dependency", async () => {
    const offenders: string[] = [];
    for (const file of sources("src/shared")) {
      const source = await Bun.file(file).text();
      if (/\b(document|window|navigator)\b\./.test(source)) {
        offenders.push(`${file}: DOM access`);
      }
      for (const statement of importStatements(source)) {
        if (isTypeOnly(statement)) continue;
        if (/from\s+["'](node:|bun|@client\/|@server\/)/.test(statement)) {
          offenders.push(`${file}: ${statement.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("style.css is a manifest and nothing else", async () => {
    // `@import` is hoisted above every other rule in a file, so a rule written
    // in style.css lands *after* every imported one and silently wins ties
    // against the pages and components it looks like it precedes. Keeping the
    // entry to imports is what makes the order on screen the cascade order.
    const source = await Bun.file(`${CLIENT}/style.css`).text();
    const offenders = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("@import "));
    expect(
      offenders,
      "style.css must hold only @import lines — put rules in base.css or a page/component file",
    ).toEqual([]);
  });

  test("the main bundle stays under its byte budget", async () => {
    // Built in memory with the same flags as `build:client`, so the number is
    // the one that ships. Nothing is written to dist/.
    const result = await Bun.build({
      entrypoints: [`${CLIENT}/main.ts`],
      minify: true,
      target: "browser",
    });
    expect(result.success).toBe(true);
    const main = result.outputs.find((output) => output.kind === "entry-point");
    expect(main).toBeDefined();
    expect(
      main?.size ?? Number.POSITIVE_INFINITY,
      "main.js is over budget — is this presentation over server-rendered rows, or a client application?",
    ).toBeLessThan(MAIN_BUNDLE_BUDGET_BYTES);
  });

  test("the block editor bundle stays under its byte budget", async () => {
    // Built in memory with the same flags as `build:client`, so the number is
    // the one that ships. Nothing is written to dist/.
    const result = await Bun.build({
      entrypoints: [`${CLIENT}/cms-form.ts`],
      minify: true,
      target: "browser",
    });
    expect(result.success).toBe(true);
    const bundle = result.outputs.find(
      (output) => output.kind === "entry-point",
    );
    expect(bundle).toBeDefined();
    expect(
      bundle?.size ?? Number.POSITIVE_INFINITY,
      "cms-form.js is over budget — it is the one client-JS exception, kept to walking server-rendered DOM rather than a client application.",
    ).toBeLessThan(CMS_FORM_BUNDLE_BUDGET_BYTES);
  });

  test("the image picker bundle stays under its byte budget", async () => {
    // Built in memory with the same flags as `build:client`, so the number is
    // the one that ships. Nothing is written to dist/.
    const result = await Bun.build({
      entrypoints: [`${CLIENT}/image-picker.ts`],
      minify: true,
      target: "browser",
    });
    expect(result.success).toBe(true);
    const bundle = result.outputs.find(
      (output) => output.kind === "entry-point",
    );
    expect(bundle).toBeDefined();
    expect(
      bundle?.size ?? Number.POSITIVE_INFINITY,
      "image-picker.js is over budget — the picker is a library grid and a drop zone, not a second application.",
    ).toBeLessThan(IMAGE_PICKER_BUNDLE_BUDGET_BYTES);
  });
});
