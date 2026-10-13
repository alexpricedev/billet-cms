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

describe("cms.css secondary button focus", () => {
  // The global `button:focus` turns the background purple, leaving the light
  // text at 2.25:1. A mouse press or a tap only sets `:focus`, not
  // `:focus-visible`, so the override has to match `:focus` as well.
  test("keeps the publish button neutral on plain focus", () => {
    const selector = /([^{}]*\.cms-publish-button:hover[^{}]*)\{/.exec(
      css,
    )?.[1];
    expect(selector).toContain(".cms-publish-button:focus");
    expect(selector).not.toContain(":focus-visible");
  });

  test("keeps the restore button neutral on plain focus", () => {
    const selector = /([^{}]*\.cms-restore-button:hover[^{}]*)\{/.exec(
      css,
    )?.[1];
    expect(selector).toContain(".cms-restore-button:focus");
    expect(selector).not.toContain(":focus-visible");
  });
});
