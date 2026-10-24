import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Layout } from "./layouts";

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
