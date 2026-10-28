import { describe, expect, test } from "bun:test";

// Rules that are only CSS — layout and specificity — are invisible to the DOM
// tests (see `.claude/skills/writing-tests/references/client.md`), so these
// guard the exact rules the layout fixes added. The visual result still needs
// `scripts/browser-smoke.test.ts` or an eye on the page; what fails here is a
// rule quietly disappearing.
const css = await Bun.file(new URL("./cms.css", import.meta.url)).text();

describe("cms.css layout", () => {
  // A long slot name or page type name is one unbroken token; without this it
  // pushes the layout wider than a phone's viewport.
  test("lets a long slot or page-type name wrap", () => {
    const rule = /([^{}]*)\{[^{}]*overflow-wrap:\s*anywhere;[^{}]*\}/.exec(css);
    expect(rule?.[1]).toContain(".cms-slot-meta code");
    expect(rule?.[1]).toContain(".cms-page-type-list code");
  });

  // A paragraph inside a list item is the item's text, so the block margin it
  // carries elsewhere would double the gap between list entries.
  test("removes the paragraph margin inside a list item", () => {
    expect(css).toMatch(/\.cms-rich-text li > p\s*\{[^}]*margin:\s*0/);
  });

  // A trailing list keeps its own bottom margin unless the edge rule outranks
  // it, so the edge rule is scoped to `.cms-field` (three class-level
  // selectors) to beat `.cms-field .cms-rich-text ul` (two classes, one tag).
  test("makes the editor's last block flush with the box", () => {
    expect(css).toMatch(
      /\.cms-field \.cms-rich-text > :last-child\s*\{[^}]*margin-bottom:\s*0/,
    );
  });
});

describe("cms.css list controls", () => {
  // The Add button marks its at-maximum state with `aria-disabled`, which is
  // invisible on its own; without a matching rule it looks exactly like an
  // enabled one (r1-1).
  test("dims the Add button when it is aria-disabled", () => {
    const rule = /([^{}]*\[aria-disabled="true"\][^{}]*)\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toContain(".cms-list-add");
    expect(rule?.[1]).toContain(".cms-list-add:disabled");
    expect(rule?.[2]).toMatch(/opacity:\s*0?\.5/);
  });
});

describe("cms.css history layout", () => {
  // `1fr` is `minmax(auto, 1fr)`, whose `auto` minimum is the content's
  // min-content width — a long author email widened the row past a 390px
  // viewport and clipped the card's right edge. `minmax(0, 1fr)` lets the
  // track shrink below its content.
  test("lets the history row shrink below its content", () => {
    expect(css).toMatch(
      /\.cms-history-item\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    );
  });

  test("stacks the history row in one column on mobile", () => {
    const mobile = /@media\s*\(max-width:\s*480px\)\s*\{([\s\S]*?)\n\}/.exec(
      css,
    )?.[1];
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr)");
    // Stacked, the restore button would otherwise sit at the end of the track.
    expect(mobile).toContain("justify-self: start");
  });

  // A long author email is one unbroken token; this is what lets it wrap inside
  // the narrowed track instead of overflowing.
  test("lets a long author email wrap", () => {
    expect(css).toMatch(
      /\.cms-history-author\s*\{[^}]*overflow-wrap:\s*anywhere/,
    );
  });
});

describe("cms.css action bar", () => {
  // Publish has to be in reach on a phone without scrolling past a long form,
  // so the bar sticks to the bottom of the viewport.
  test("sticks the action bar to the bottom", () => {
    expect(css).toMatch(/\.cms-actions\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.cms-actions\s*\{[^}]*bottom:\s*0/);
  });

  // A bar that is a card with a max-width reads as a panel in the form rather
  // than the page's own action strip; this is the full-width hairline version.
  test("keeps the bar full width with a hairline, not a card", () => {
    const rule = /\.cms-actions\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toContain("border-top: 1px solid var(--border)");
    expect(rule).not.toContain("border-radius");
    expect(rule).not.toContain("max-width");
  });

  // The legacy `.cms-*` button classes are styled through the `.btn` variants;
  // no rule of their own may reintroduce a background the variant cannot see.
  test("styles the legacy buttons through the variants", () => {
    expect(css).not.toMatch(/\.cms-publish-button\s*\{/);
    expect(css).not.toMatch(/\.cms-preview-button\s*\{/);
  });

  test("stacks the bar into two columns on a phone", () => {
    const mobile = /@media\s*\(width <= 640px\)\s*\{([\s\S]*?)\n\}/.exec(
      css,
    )?.[1];
    expect(mobile).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    // The status line spans both columns so it is not squeezed into half of one.
    expect(mobile).toContain("grid-column: 1 / -1");
  });
});

describe("cms.css secondary button focus", () => {
  // The global `button:focus` turns the background purple, leaving the light
  // text at 2.25:1. A mouse press or a tap only sets `:focus`, not
  // `:focus-visible`, so the override has to match `:focus` as well.
  test("keeps the restore button neutral on plain focus", () => {
    const selector = /([^{}]*\.cms-restore-button:hover[^{}]*)\{/.exec(
      css,
    )?.[1];
    expect(selector).toContain(".cms-restore-button:focus");
    expect(selector).not.toContain(":focus-visible");
  });
});

describe("cms.css media layout", () => {
  // A `12rem` floor in an `auto-fill` track is wider than a phone's viewport,
  // so the track floors at 100% instead and a long unbroken alt can't widen it.
  test("floors the media grid track at the viewport", () => {
    expect(css).toMatch(
      /\.cms-media-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(12rem,\s*100%\),\s*1fr\)\)/,
    );
  });

  // A grid item's automatic minimum is its content, so without this the long
  // alt text widens the card past its column.
  test("lets a media card shrink below its content", () => {
    expect(css).toMatch(/\.cms-media-card\s*\{[^}]*min-width:\s*0/);
  });

  test("pins a media card's content to the top", () => {
    expect(css).toMatch(/\.cms-media-card\s*\{[^}]*align-content:\s*start/);
  });

  test("wraps a long alt inside the card", () => {
    expect(css).toMatch(/\.cms-media-alt\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  test("caps the delete preview at the viewport and spaces it below itself", () => {
    expect(css).toMatch(
      /\.cms-media-delete-preview\s*\{[^}]*max-width:\s*min\(24rem,\s*100%\)/,
    );
    expect(css).toMatch(
      /\.cms-media-delete-preview\s*\{[^}]*margin-bottom:\s*1rem/,
    );
  });

  // `.cms-actions` is a flex row for the publish bar; the Uses section needs a
  // block layout of its own instead of being laid out beside its heading.
  test("lays the Uses section out as a block", () => {
    expect(css).toMatch(/\.cms-media-uses\s*\{[^}]*display:\s*grid/);
  });

  test("spaces the upload and detail forms at 1.5rem", () => {
    expect(css).toMatch(/\.cms-media-upload\s*\{[^}]*gap:\s*1\.5rem/);
    expect(css).toMatch(/\.cms-media-detail\s*\{[^}]*gap:\s*1\.5rem/);
  });

  test("keeps the Upload and Save buttons at their natural width", () => {
    expect(css).toMatch(
      /\.cms-media-upload \.cms-save\s*\{[^}]*justify-self:\s*start/,
    );
    expect(css).toMatch(
      /\.cms-media-detail \.cms-save\s*\{[^}]*justify-self:\s*start/,
    );
  });

  test("strips the focal legend padding and trims the help margin", () => {
    expect(css).toMatch(/\.cms-focal-field legend\s*\{[^}]*padding:\s*0/);
    expect(css).toMatch(
      /\.cms-focal-field \.cms-field-help\s*\{[^}]*margin:\s*0 0 0?\.6rem/,
    );
  });
});
