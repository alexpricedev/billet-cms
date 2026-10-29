import { describe, expect, test } from "bun:test";

// Rules that are only CSS — layout and specificity — are invisible to the DOM
// tests (see `.claude/skills/writing-tests/references/client.md`), so these
// guard the exact rules the layout fixes added. The visual result still needs
// `scripts/browser-smoke.test.ts` or an eye on the page; what fails here is a
// rule quietly disappearing.
const css = await Bun.file(new URL("./cms.css", import.meta.url)).text();
const layoutCss = await Bun.file(
  new URL("../components/layout.css", import.meta.url),
).text();
const baseCss = await Bun.file(new URL("../base.css", import.meta.url)).text();

// `[selector, body]` for every rule in a stylesheet. Comments are stripped
// first: prose that names a selector would otherwise be captured as part of the
// next rule's selector, and `[^{}]` stops at a nested block the way a real
// parser would, so a rule inside `@media` is matched on its own.
const rules = (source: string): [string, string][] =>
  [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]*)\{([^{}]*)\}/g),
  ].map((match) => [match[1] ?? "", match[2] ?? ""]);

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
  // The hairline lives on the backdrop, not on the bar's own box: a border
  // here would draw a second line over the form column, a pixel above the
  // full-pane one, which is the clipped look the ticket started from.
  test("keeps the bar full width with one hairline, not a card", () => {
    const rule = /\.cms-actions\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).not.toContain("border-top");
    expect(rule).not.toContain("border-radius");
    expect(rule).not.toContain("max-width");
  });

  // The bar's own box is the form column, and `.app-content` is centred under
  // `--content-max`, so at a wide window that box ends well inside the pane
  // however far its padding is bled. The backdrop is a pseudo-element measured
  // in container units off `.app-main` instead: half the bar minus half the
  // pane cancels the column's centring at any width, and subtracting the pane's
  // padding token reaches the sidebar and the viewport edge. `vw` would count
  // the scrollbar's gutter and overhang the pane.
  test("paints the bar's surface across the whole main pane", () => {
    const bar = /\.cms-actions\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(bar).toContain("background: var(--surface)");

    const rule = /\.cms-actions::before\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toContain('content: ""');
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("background: var(--surface)");
    expect(rule).toContain("border-top: 1px solid var(--border)");
    expect(rule).toContain("box-shadow: var(--shadow-bar)");
    expect(rule).toMatch(
      /left:\s*calc\(50% - 50cqw - var\(--app-main-pad-x\)\)/,
    );
    expect(rule).toMatch(
      /right:\s*calc\(50% - 50cqw - var\(--app-main-pad-x\)\)/,
    );
    expect(rule).not.toContain("100vw");
    // Tokens only: the new rule introduces no colour literal.
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // The backdrop above is only full-pane at any width if the pane is a size
  // container whose horizontal padding is the same token the backdrop cancels.
  // Scoped with `:has()` so a page without the bar never pays for containment.
  test("sizes the backdrop from the pane, not the content column", () => {
    const main = /^\.app-main\s*\{([^}]*)\}/m.exec(layoutCss)?.[1];
    expect(main).toContain("--app-main-pad-x: var(--space-10)");
    expect(main).toContain(
      "padding: var(--space-8) var(--app-main-pad-x) var(--space-16)",
    );
    // Containment is scoped to the editor, not paid for by every page.
    expect(main).not.toContain("container-type");
    const scoped = /\.app-main:has\(\.cms-actions\)\s*\{([^}]*)\}/.exec(
      layoutCss,
    )?.[1];
    expect(scoped).toContain("container-type: inline-size");

    // The wide-window premise: the content column is centred under a max-width,
    // so its own box stops short of the pane however far padding is bled.
    const content = /^\.app-content\s*\{([^}]*)\}/m.exec(layoutCss)?.[1];
    expect(content).toContain("max-width: var(--content-max)");
    expect(content).toContain("margin-inline: auto");

    // Both narrower breakpoints redefine the padding the backdrop uses, so the
    // two stay in step at 900px and 640px.
    const at900 = /@media\s*\(width <= 900px\)\s*\{([\s\S]*?)\n\}/.exec(
      layoutCss,
    )?.[1];
    expect(at900).toContain("--app-main-pad-x: var(--space-5)");
    const at640 = /@media\s*\(width <= 640px\)\s*\{([\s\S]*?)\n\}/.exec(
      layoutCss,
    )?.[1];
    expect(at640).toContain("--app-main-pad-x: var(--space-4)");
  });

  // The bar is the flow's last element and sticks to the window, so the pane's
  // own bottom padding would sit under it at full scroll: a strip of page
  // between the bar's bottom edge and the footer. Only the pane carrying the
  // bar drops it — scoped with `:has()`, so every other page keeps the
  // breathing room `.app-main` gives it, including at the narrower breakpoints
  // that redefine its padding.
  test("drops the pane's bottom padding on the editor only", () => {
    const main = /^\.app-main\s*\{([^}]*)\}/m.exec(layoutCss)?.[1];
    expect(main).toContain(
      "padding: var(--space-8) var(--app-main-pad-x) var(--space-16)",
    );

    const editorRules = rules(layoutCss).filter(([selector]) =>
      /\.app-main[^{]*:has\(\.cms-actions\)/.test(selector),
    );
    expect(editorRules.length).toBeGreaterThan(0);
    // The rule that zeroes it is scoped to the editor; a page without the bar
    // never matches, so the base padding above stays in force there.
    expect(editorRules[0]?.[1]).toContain("padding-bottom: 0");

    // Every other rule naming the editor pane may only repeat the zero: a
    // media block that re-adds a bottom padding (or a `padding` shorthand with
    // one) puts the strip back at that width while passing the match above.
    for (const [, body] of editorRules) {
      for (const [, value] of body.matchAll(/padding-bottom\s*:\s*([^;]+)/g)) {
        expect(value.trim()).toBe("0");
      }
      for (const [, value] of body.matchAll(/(?<!-)padding\s*:\s*([^;]+)/g)) {
        expect(value.trim()).toBe("0");
      }
    }
  });

  // Dropping the padding was only half of it. The body grid's first row is
  // `1fr`, so a pane shorter than the window is stretched to fill it and the
  // footer sits at the bottom — with the spare height *below* the content
  // column, a band between the bar and the footer again. The column has to
  // fill the pane, and the form has to take the slack, so the bar ends on the
  // footer whether the form is long or short. Remove any of the three and the
  // band comes back at some window height.
  test("fills the editor column so the bar lands on the footer", () => {
    const column =
      /\.app-main:has\(\.cms-actions\) > \.app-content\s*\{([^}]*)\}/.exec(
        layoutCss,
      )?.[1];
    expect(column).toContain("display: flex");
    expect(column).toContain("flex-direction: column");
    expect(column).toContain("min-height: 100%");

    const grow = rules(layoutCss).filter(
      ([selector, body]) =>
        /\.cms-slot-form\b/.test(selector) &&
        /\.cms-page-form\b/.test(selector) &&
        /flex:\s*1/.test(body),
    );
    expect(grow).toHaveLength(1);
    // Editor-only, and it grows the form, not the bar: growing the bar would
    // stretch its painted surface over the slack instead of leaving the page
    // background there.
    expect(grow[0]?.[0]).toContain(".app-main:has(.cms-actions)");
    expect(grow[0]?.[0]).toMatch(/\.app-content\s*>\s*\.cms-slot-form/);
    expect(grow[0]?.[0]).toMatch(/\.app-content\s*>\s*\.cms-page-form/);
  });

  // The bar sticks over the form while it scrolls, but it is also the flow's
  // last element, so it already reserves its own height at the end. A second
  // stack of padding on the form doubles that gap: at full scroll the last
  // help line floated 136px above the bar at 1280 and 200px at 390. The form
  // takes no bottom padding of its own, and the one gap it does leave is the
  // bar's `margin-top` — the normal section spacing.
  //
  // Every rule naming either form is checked, at every breakpoint, rather than
  // one anchored at the selector's start: a scoped rule like
  // `.cms-page-form:not(.cms-new-page-form) { padding-bottom: … }` put the
  // doubled gap back while passing an anchored match, and so did any literal.
  test("leaves only the bar's own flow space below the form", () => {
    const formRules = rules(css).filter(([selector]) =>
      /\.cms-(?:slot|page)-form\b/.test(selector),
    );
    expect(formRules.length).toBeGreaterThan(0);
    for (const [, body] of formRules) {
      expect(body).not.toContain("padding-bottom");
    }

    expect(css).toMatch(
      /\.cms-actions\s*\{[^}]*margin-top:\s*var\(--space-6\)/,
    );
  });

  // The shadow is a token in every theme block, so light, dark and System all
  // draw the same soft upward edge rather than a bare border.
  test("defines the bar shadow in both themes and System", () => {
    const light = /:root\s*\{([\s\S]*?)\n\}/.exec(baseCss)?.[1];
    expect(light).toContain("--shadow-bar:");
    const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(
      baseCss,
    )?.[1];
    expect(dark).toContain("--shadow-bar:");
    const system =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(
        baseCss,
      )?.[1];
    expect(system).toContain("--shadow-bar:");
  });

  // The legacy `.cms-*` button classes are styled through the `.btn` variants;
  // no rule of their own may reintroduce a background the variant cannot see.
  // Every `.cms-save` rule is checked, not just a bare one: `.cms-save` sits on
  // both Save draft and Publish, and page CSS loads after base.css, so a fill
  // in any rule that names it beats `btn-secondary` and leaves two filled
  // buttons in the bar. One primary per bar means the variant decides.
  test("styles the legacy buttons through the variants", () => {
    expect(css).not.toMatch(/\.cms-publish-button\s*\{/);
    expect(css).not.toMatch(/\.cms-preview-button\s*\{/);

    const saveRules = rules(css).filter(([selector]) =>
      selector.includes(".cms-save"),
    );
    expect(saveRules.length).toBeGreaterThan(0);
    for (const [, body] of saveRules) {
      expect(body).not.toContain("background");
      expect(body).not.toContain("border");
      expect(body).not.toContain("color");
    }
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
    // The bar's last row clears a phone's home indicator.
    expect(mobile).toContain("env(safe-area-inset-bottom, 0px)");
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
