import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { Theme } from "../services/preferences";
import { BaseLayout, ErrorLayout, Layout } from "./layouts";

const editor = (theme?: Theme) => ({
  id: "00000000-0000-0000-0000-000000000001",
  email: "editor@example.com",
  role: "admin",
  ...(theme ? { theme } : {}),
});

const render = (theme: Theme) =>
  renderToString(
    <Layout title="Account" name="account" user={editor(theme)}>
      <p>body</p>
    </Layout>,
  );

/**
 * The full layout's `<head>` and `<body>` scripts.
 *
 * The Lottie player was the CMS's only cross-origin script: it loaded from
 * unpkg with a `preconnect`/`dns-prefetch` in the head and an `integrity` hash,
 * and the CSP carried the unpkg origin for it. All four are gone. A re-added
 * third-party script is silent — the unit suite never loads a page — so the
 * layout's own output is asserted here as well as the policy in
 * `security-headers.test.ts`.
 */
describe("Layout", () => {
  const html = renderToString(
    <Layout title="Home" name="home">
      <p>body</p>
    </Layout>,
  );

  test("loads no cross-origin script", () => {
    expect(html).not.toContain("unpkg");
    expect(html).not.toContain("lottie");
    // Preact lower-cases attribute names, so `crossOrigin` could never appear
    // in the rendered HTML; assert the lowercase form, and that no script tag
    // points at a remote URL at all.
    expect(html).not.toContain("crossorigin");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    // The one script is the first-party nav bundle.
    expect(html).toContain('type="module"');
    expect(html).toContain("/assets/main.js");
  });

  test("ships its JSON-LD as a data block", () => {
    // `application/ld+json` is never executed and CSP does not check it, which
    // is why `script-src` needs no 'unsafe-inline'. It renders only when
    // indexing is on and the page is indexable (every CMS page is private, so
    // the browser smoke tests never see it).
    const previous = process.env.ALLOW_INDEXING;
    process.env.ALLOW_INDEXING = "true";
    const indexable = renderToString(
      <Layout title="Home" name="home">
        <p>body</p>
      </Layout>,
    );
    if (previous === undefined) delete process.env.ALLOW_INDEXING;
    else process.env.ALLOW_INDEXING = previous;

    const match = indexable.match(
      /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    expect(() => JSON.parse(match?.[1] ?? "")).not.toThrow();
  });

  test("opens no cross-origin connection", () => {
    expect(html).not.toContain("preconnect");
    expect(html).not.toContain("dns-prefetch");
  });
});

/**
 * The editor's theme is written into the page, not applied by a script, so
 * there is no flash of the wrong colours. System is the old behaviour and the
 * only one a signed-out page can get.
 */
describe("Layout theme", () => {
  test("light marks the document and pins the light chrome", () => {
    const html = render("light");

    expect(html).toContain('data-theme="light"');
    expect(html).toMatch(/<html[^>]*style="color-scheme:light;"/);
    expect(html).toMatch(/name="color-scheme" content="light"/);
    // One theme-color, the light one, with no media query: the editor's
    // choice wins over the operating system.
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
    expect(html).toMatch(/name="theme-color" content="#fafafa"/);
    expect(html).not.toContain("prefers-color-scheme");
  });

  test("dark marks the document and pins the dark chrome", () => {
    const html = render("dark");

    expect(html).toContain('data-theme="dark"');
    expect(html).toMatch(/<html[^>]*style="color-scheme:dark;"/);
    expect(html).toMatch(/name="color-scheme" content="dark"/);
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
    expect(html).toMatch(/name="theme-color" content="#090909"/);
    expect(html).not.toContain("prefers-color-scheme");
  });

  test("system leaves the document unmarked and follows the OS", () => {
    const html = render("system");

    expect(html).not.toContain("data-theme");
    expect(html).toMatch(/<html[^>]*style="color-scheme:light dark;"/);
    expect(html).toMatch(/name="color-scheme" content="light dark"/);
    expect(html.match(/name="theme-color"/g)).toHaveLength(2);
    expect(html).toMatch(
      /name="theme-color" content="#fafafa" media="\(prefers-color-scheme: light\)"/,
    );
    expect(html).toMatch(
      /name="theme-color" content="#090909" media="\(prefers-color-scheme: dark\)"/,
    );
  });

  test("a signed-out page gets none", () => {
    const html = renderToString(
      <Layout title="Home" name="home" user={null}>
        <p>body</p>
      </Layout>,
    );

    expect(html).not.toContain("data-theme");
    expect(html).toMatch(/name="color-scheme" content="light dark"/);
    expect(html.match(/name="theme-color"/g)).toHaveLength(2);
  });

  test("ErrorLayout and BaseLayout always render System", () => {
    for (const layout of [
      renderToString(<ErrorLayout title="Not found">body</ErrorLayout>),
      renderToString(<BaseLayout title="Not found">body</BaseLayout>),
    ]) {
      expect(layout).not.toContain("data-theme");
      expect(layout).toMatch(/name="color-scheme" content="light dark"/);
      expect(layout.match(/name="theme-color"/g)).toHaveLength(2);
    }
  });
});
