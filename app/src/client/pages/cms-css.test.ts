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
