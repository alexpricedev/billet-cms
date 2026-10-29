import { describe, expect, test } from "bun:test";

// The theme scoping is CSS only — which token block wins is invisible to the
// DOM tests — so these guard the three scopes the theme setting depends on. The
// visual result still needs an eye on the page (`scripts/browser-smoke.test.ts`
// or the sandbox); what fails here is a selector quietly changing.
const css = await Bun.file(new URL("./base.css", import.meta.url)).text();

// The full `--token: value` declarations, so a value edited in one copy and not
// the other fails here too — not just a token added to one list and not the
// other.
function declarations(block: string): string[] {
  return block
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== "")
    .sort();
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

  // The two dark blocks are a deliberate duplicate — plain CSS has no way to
  // put one declaration block under both an attribute selector and a media
  // query — so if a token or a value changes in one it has to change in the
  // other, or System and the explicit Dark setting drift.
  test("the two dark token lists agree", () => {
    const explicit = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
    const media =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(explicit).toBeDefined();
    expect(media).toBeDefined();
    expect(declarations(explicit ?? "")).toEqual(declarations(media ?? ""));
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

describe("base.css banner tokens", () => {
  // One tint per tone, defined in every theme scope. A tone missing from one
  // scope falls back to whatever the unqualified `:root` declared — light
  // colours on a dark page — so each scope carries all twelve.
  const light = {
    "--banner-success-bg": "#f0faf3",
    "--banner-success-border": "#bfe3cb",
    "--banner-success-icon": "#15803d",
    "--banner-info-bg": "#f2f6fd",
    "--banner-info-border": "#c9d7f2",
    "--banner-info-icon": "#1d4ed8",
    "--banner-warning-bg": "#fff8eb",
    "--banner-warning-border": "#f0d9a8",
    "--banner-warning-icon": "#b45309",
    "--banner-error-bg": "#fef3f2",
    "--banner-error-border": "#f3c4c0",
    "--banner-error-icon": "#b91c1c",
  };
  const dark = {
    "--banner-success-bg": "#0d231a",
    "--banner-success-border": "#1d4b37",
    "--banner-success-icon": "#3dd68c",
    "--banner-info-bg": "#0e1a2e",
    "--banner-info-border": "#1e3a66",
    "--banner-info-icon": "#6ea8fe",
    "--banner-warning-bg": "#241a08",
    "--banner-warning-border": "#4d3a12",
    "--banner-warning-icon": "#f5b544",
    "--banner-error-bg": "#2a1110",
    "--banner-error-border": "#5a2320",
    "--banner-error-icon": "#ff6b6b",
  };

  function expectTokens(block: string | undefined, tokens: object) {
    expect(block).toBeDefined();
    for (const [token, value] of Object.entries(tokens)) {
      expect(block).toContain(`${token}: ${value}`);
    }
  }

  test("defines all four tones in the light :root", () => {
    expectTokens(/:root\s*\{([^}]*)\}/.exec(css)?.[1], light);
  });

  test('defines all four tones under [data-theme="dark"]', () => {
    expectTokens(
      /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1],
      dark,
    );
  });

  test("defines all four tones in the System media query", () => {
    expectTokens(
      /:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/.exec(css)?.[1],
      dark,
    );
  });
});

describe("base.css choice rows", () => {
  // The alignment wart: a radio on the inline baseline and carrying the
  // browser's default margin sits high and indented from the card's edge.
  test("centres a radio or checkbox on its label, with no indent", () => {
    const row =
      /label:has\(> input\[type="radio"\]\),\s*label:has\(> input\[type="checkbox"\]\)\s*\{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(row).toBeDefined();
    expect(row).toContain("align-items: center");
    expect(row).toContain("display: flex");
    expect(row).toContain("gap: var(--space-2)");

    const control =
      /label > input\[type="radio"\],\s*label > input\[type="checkbox"\]\s*\{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(control).toBeDefined();
    expect(control).toContain("margin: 0");
  });

  // Three rows read as one group only if they share the same vertical rhythm.
  test("spaces every choice row by one step from the scale", () => {
    const group = /\.choice-group\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(group).toBeDefined();
    expect(group).toContain("gap: var(--space-2)");
  });
});
