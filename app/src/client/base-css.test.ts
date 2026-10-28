import { describe, expect, test } from "bun:test";

// The theme scoping is CSS only — which token block wins is invisible to the
// DOM tests — so these guard the three scopes the theme setting depends on. The
// visual result still needs an eye on the page (`scripts/browser-smoke.test.ts`
// or the sandbox); what fails here is a selector quietly changing.
const css = await Bun.file(new URL("./base.css", import.meta.url)).text();

function tokens(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]).sort();
}

describe("base.css theme scopes", () => {
  // Dark is chosen in the CMS, so the tokens cannot sit behind a media query —
  // they apply whenever the server wrote the attribute.
  test('applies the dark tokens under [data-theme="dark"]', () => {
    const block = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain("--canvas: #090909");
    expect(block).toContain("--text: #ededed");
    expect(block).toContain("--button-primary-bg: #ededed");
  });

  // System is the default (and every signed-out page), so the OS setting still
  // decides — but only when no page has claimed a theme.
  test("scopes the OS dark media query to pages with no data-theme", () => {
    const media =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(
        css,
      )?.[1];
    expect(media).toBeDefined();
    expect(media).toMatch(/:root:not\(\[data-theme\]\)\s*\{/);
    expect(media).toContain("--canvas: #090909");
  });

  // Light needs no block at all: the unqualified `:root` tokens are the light
  // palette, and a `[data-theme="light"]` page matches neither dark selector.
  test('nothing is scoped to [data-theme="light"]', () => {
    expect(css).not.toMatch(/\[data-theme="light"\]\s*\{/);
  });

  // The two dark blocks are a deliberate duplicate; if a token is added to one
  // it has to land in the other, or System and the explicit Dark setting drift.
  test("the two dark token lists agree", () => {
    const explicit = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
    const media =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(
        css,
      )?.[1];
    expect(explicit).toBeDefined();
    expect(media).toBeDefined();
    expect(tokens(explicit ?? "")).toEqual(tokens(media ?? ""));
  });

  // A `:root` block later in the file would tie on specificity with the light
  // tokens; keeping the dark rules after it leaves the cascade obvious.
  test("keeps the dark blocks after the light :root", () => {
    const lightRoot = css.indexOf(":root {");
    expect(lightRoot).toBeGreaterThan(-1);
    expect(css.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(lightRoot);
    expect(css.indexOf("@media (prefers-color-scheme: dark)")).toBeGreaterThan(
      lightRoot,
    );
  });
});
