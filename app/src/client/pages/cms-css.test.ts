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

  // Every editor ends its flow with the action bar, and the bar sticks to the
  // window, so the pane's own bottom padding would sit under it at full scroll:
  // a strip of page between the bar's bottom edge and the footer. Only the
  // pane carrying the bar drops it — scoped with `:has()`, so every other page
  // keeps the breathing room `.app-main` gives it, including at the narrower
  // breakpoints that redefine its padding.
  test("drops the editor pane's bottom padding under the bar", () => {
    const main = /^\.app-main\s*\{([^}]*)\}/m.exec(layoutCss)?.[1];
    expect(main).toContain(
      "padding: var(--space-8) var(--app-main-pad-x) var(--space-16)",
    );

    const editorRules = rules(layoutCss).filter(([selector]) =>
      /\.app-main[^{]*:has\(\.cms-actions\)/.test(selector),
    );
    expect(editorRules.length).toBeGreaterThan(0);

    // The pane is a size container on every editor page — the bar's backdrop is
    // measured in `cqw` — whatever the flow ends with.
    const containers = editorRules.filter(([, body]) =>
      /container-type:\s*inline-size/.test(body),
    );
    expect(containers).toHaveLength(1);
    expect(containers[0]?.[0]).not.toMatch(/:not\(/);

    // The zero applies to every editor pane: the bar is the flow's last
    // element on a page editor too.
    const zeroed = editorRules.filter(([, body]) =>
      /padding-bottom\s*:\s*0/.test(body),
    );
    expect(zeroed).toHaveLength(1);
    expect(zeroed[0]?.[0]).toMatch(/\.app-main:has\(\.cms-actions\)\s*$/);
    expect(zeroed[0]?.[0]).not.toContain(":not(");

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
  // fill the pane, and the form has to take the slack, so the flow's last
  // element — the bar, on every editor — ends on the footer's edge whether the
  // form is long or short. Remove any of the three and the band comes back at
  // some window height.
  test("fills the editor column so the bar lands on the footer", () => {
    // The percentage needs a definite height: only the grid shell gives
    // `.app-main` one, by stretching its `1fr` row. Below 900px the shell is
    // `display: block` and the footer follows the content instead of the
    // window, so there is no spare row for a band to sit in — but the
    // percentage would resolve against `auto` and do nothing. Pin the scope,
    // or a later width change silently brings the band back.
    const desktop = /@media\s*\(width >= 901px\)\s*\{([\s\S]*?)\n\}/.exec(
      layoutCss,
    )?.[1];
    expect(desktop).toBeDefined();

    const column =
      /\.app-main:has\(\.cms-actions\) > \.app-content\s*\{([^}]*)\}/.exec(
        desktop ?? "",
      )?.[1];
    expect(column).toContain("display: flex");
    expect(column).toContain("flex-direction: column");
    expect(column).toContain("min-height: 100%");

    const at900 = /@media\s*\(width <= 900px\)\s*\{([\s\S]*?)\n\}/.exec(
      layoutCss,
    )?.[1];
    expect(at900).toContain("display: block");

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

  // The ticket's review put --field-gap between the drop zone, Upload all and
  // the staged tiles, and between tiles; the detail form keeps its 1.5rem.
  test("spaces the uploader's parts and tiles at the field gap", () => {
    expect(css).toMatch(
      /\.cms-media-uploader\s*\{[^}]*gap:\s*var\(--field-gap\)/,
    );
    expect(css).toMatch(/\.cms-media-tiles\s*\{[^}]*gap:\s*var\(--field-gap\)/);
    expect(css).toMatch(/\.cms-media-detail\s*\{[^}]*gap:\s*1\.5rem/);
  });

  test("keeps Upload all and Save at their natural width", () => {
    expect(css).toMatch(
      /\.cms-media-upload-all\s*\{[^}]*justify-self:\s*start/,
    );
    expect(css).toMatch(
      /\.cms-media-detail \.cms-save\s*\{[^}]*justify-self:\s*start/,
    );
  });

  // A tile's preview is fixed and its body grows; without min-width: 0 the
  // body's text and input push the tile past a 320px viewport.
  test("lets the staged tile and its body shrink", () => {
    expect(css).toMatch(/\.cms-media-tile\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.cms-media-tile-body\s*\{[^}]*min-width:\s*0/);
  });

  test("strips the focal legend padding and trims the help margin", () => {
    expect(css).toMatch(/\.cms-focal-field legend\s*\{[^}]*padding:\s*0/);
    expect(css).toMatch(
      /\.cms-focal-field \.cms-field-help\s*\{[^}]*margin:\s*0 0 0?\.6rem/,
    );
  });
});

describe("cms.css block headers", () => {
  // "Block N" has to follow the block's place in the list, not an index the
  // server wrote: a CSS counter over the rendered cards renumbers them after an
  // add, a move or a remove, with no script and nothing to go stale. The reset
  // sits on the list so a second page content area counts from one again.
  test("numbers blocks with a counter over the list", () => {
    expect(css).toMatch(/\.cms-blocks\s*\{[^}]*counter-reset:\s*cms-block/);
    expect(css).toMatch(/\.cms-block\s*\{[^}]*counter-increment:\s*cms-block/);

    const prefix = /\.cms-block-legend::before\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(prefix).toContain('content: "Block " counter(cms-block) " · "');
  });

  // Variant A: the card keeps its stronger border and tinted header band, and
  // has no left rail. The band is what makes the number readable at a glance;
  // losing either would be a design change, not a tidy-up.
  test("keeps the stronger border and header band, with no left rail", () => {
    const block = /\.cms-block\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(block).toContain("border: 1px solid var(--border-strong)");
    expect(block).not.toContain("border-left");

    const legend = /\.cms-block-legend\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(legend).toContain("background: var(--surface-subtle)");
    expect(legend).toContain("border-bottom: 1px solid var(--border)");
  });

  // "Block 6 · Banner" is one heading: the number and the name share a type
  // family and size, rather than a sans prefix followed by a monospace name.
  test("sets Block N and the block name in the same type", () => {
    const code = /\.cms-block-legend code\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(code).toContain("font-family: inherit");
    expect(code).toContain("font-size: inherit");
    expect(code).not.toContain("--font-mono");
  });
});

describe("cms.css group headings", () => {
  // A group heading names the container and is set heavier than the sub-labels
  // it introduces. Two labels at the same weight, one directly above the other,
  // read as two labels for the same control.
  test("sets group headings heavier than their sub-labels", () => {
    const rule = rules(css).find(
      ([selector]) =>
        selector.includes(".cms-field-link > .cms-field-label") &&
        selector.includes(".cms-field-group > .cms-field-label"),
    );
    expect(rule?.[1]).toContain("font-weight: 600");
  });

  // `--space-3` of air below the heading is what stops the first sub-label
  // reading as a continuation of it. The link box reserves it in its top
  // padding (the legend is out of flow), the group in its grid gap.
  test("keeps at least --space-3 below a group heading", () => {
    const group = /\.cms-field-group\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(group).toContain("gap: var(--space-3)");

    const link = /\.cms-field-link\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(link).toMatch(/padding:\s*calc\(14px \+ 18px \+ var\(--space-3\)\)/);
  });
});

describe("cms.css editor field rhythm", () => {
  // Both sizes are tokens so a field box and the space between fields move
  // together: the height the link field already used, and one gap for every
  // field list instead of four different space steps.
  test("defines one field height and one field gap", () => {
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(baseCss)?.[1];
    expect(root).toContain("--field-height: 44px");
    expect(root).toContain("--field-gap: var(--space-4)");
  });

  // A text(), an image alt and the link field's boxes are the same control.
  // The rule is an allow-list of single-line text-like inputs (plus selects),
  // so a checkbox, radio, hidden input, file, button, colour or range control
  // keeps its own size; textareas keep their own three-row/auto-grown size and
  // stay out of the selector. The image picker's modal is rendered inside the
  // fieldset but is chrome rather than a field box, so the whole overlay is
  // excluded: its search input keeps the base control size.
  test("sizes every single-line field control from the token", () => {
    const rule = rules(css).find(
      ([selector, body]) =>
        /\.cms-field[^{]*input/.test(selector) &&
        /height:\s*var\(--field-height\)/.test(body),
    );
    expect(rule).toBeDefined();

    const selector = (rule?.[0] ?? "").replace(/\s+/g, " ");
    for (const type of ["text", "url", "email", "tel", "search"]) {
      expect(selector).toContain(`[type="${type}"]`);
    }
    // No `type` means `text` in the browser, so it is in the allow-list too.
    // Pin the whole branch: `input:not([type]` alone would also match
    // `input:not([type="checkbox"])`, a broad exclusion.
    expect(selector).toContain("input:not([type], .cms-picker-overlay *)");
    expect(selector).toContain(".cms-field select:not(.cms-picker-overlay *)");
    // The image picker's dialog sits inside the fieldset; its own controls
    // (the search box) are not field boxes and keep the base size. Every
    // branch carries the exclusion — one dropped branch stretches the search
    // box again — so count them rather than finding it somewhere.
    expect(selector.match(/\.cms-picker-overlay \*/g) ?? []).toHaveLength(3);
    expect(selector).not.toContain("textarea");
    // Not a broad exclusion that would catch every other input type.
    expect(selector).not.toContain('[type="checkbox"]');
  });

  // The link field's hard-coded 44px was the only field-box height; every
  // field control now takes the token. A literal left on a field or link rule
  // is the thing that drifts when the token changes.
  test("leaves no literal field-box height in cms.css", () => {
    const fieldRules = rules(css).filter(([selector]) =>
      /\.cms-(?:field|link)\b/.test(selector),
    );
    expect(fieldRules.length).toBeGreaterThan(0);
    for (const [selector, body] of fieldRules) {
      expect(body, selector).not.toMatch(/\b44px\b/);
    }
  });

  // Four lists used to space their fields at --space-5, --space-4 and
  // --space-3; they all answer to the one gap token now.
  test("spaces every editor field list from the gap token", () => {
    for (const wanted of [
      ".cms-fields",
      ".cms-new-page-form",
      ".cms-page-settings",
      ".cms-field-group [data-group-fields]",
    ]) {
      const rule = rules(css).find(
        ([selector, body]) =>
          selector.trim() === wanted && /gap:\s*var\(--field-gap\)/.test(body),
      );
      expect(rule, wanted).toBeDefined();
    }
  });

  // Inside a field the label sits 6px above its control, and the help,
  // character count, errors and warnings sit that same 6px below it: the
  // field's own grid gap is the whole rhythm, so none of them may add a
  // margin or padding of their own.
  test("keeps help, count, errors and warnings on the field's 6px rhythm", () => {
    const field = rules(css).find(
      ([selector]) => selector.trim() === ".cms-field",
    );
    expect(field?.[1]).toContain("gap: 6px");

    for (const name of [
      ".cms-field-help",
      ".cms-char-count",
      ".cms-field-errors",
      ".cms-field-warning",
    ]) {
      const rule = rules(css).find(([selector]) => selector.trim() === name);
      expect(rule?.[1], name).toContain("margin: 0");
      expect(rule?.[1], name).not.toContain("padding");
    }
  });

  // The character counter sits on the label line, not on a row below the box:
  // an empty counter row under the Heading box read as a wider field gap. The
  // label may wrap; the counter keeps its width so the two never overlap.
  test("puts the character counter on the label row", () => {
    const row = /\.cms-field-label-row\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(row).toContain("align-items: baseline");
    expect(row).toContain("display: flex");
    expect(row).toContain("gap: var(--space-2)");
    expect(row).toContain("justify-content: space-between");

    const counter = /\.cms-char-count\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(counter).toContain("flex: none");
  });

  // The image field is composite: its parts are spaced like separate fields,
  // while each part keeps the 6px label-to-control rhythm. A fieldset's legend
  // is out of flow, so the wrapper carries the heading's --space-3 itself
  // unless field help sits between the two and the field's gap already does.
  // The heading titles the parts, so it is weighted like a group heading
  // rather than a second label stacked on the picker's visually hidden legend.
  test("spaces the image field's parts like separate fields", () => {
    const parts = /\.cms-image-parts\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(parts).toContain("gap: var(--field-gap)");
    expect(parts).toContain("margin-top: var(--space-3)");

    // A legend is outside the fieldset's grid, so a help line under the image
    // heading takes the field's 6px itself. A list row's span label is inside
    // the grid: the wrapper gives up the 6px its gap already contributes, and
    // help above it zeroes the wrapper's heading air.
    const ruleFor = (name: string) =>
      rules(css).find(([selector]) => selector.trim() === name)?.[1];
    expect(ruleFor(".cms-image-help")).toContain("margin-top: 6px");
    expect(ruleFor(".cms-image-parts-after-label")).toContain(
      "calc(var(--space-3) - 6px)",
    );
    expect(ruleFor(".cms-image-parts-after-help")).toContain("margin-top: 0");

    const part = /\.cms-image-part\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(part).toContain("gap: 6px");

    // The closed picker is a field box: it fills the field's width rather than
    // shrinking to its buttons, wherever it sits (an image part or a setting).
    expect(ruleFor(".cms-image-picker")).toContain("width: 100%");

    const label =
      /\.cms-field\[data-field-kind="image"\] > \.cms-field-label\s*\{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(label).toContain("font-weight: 600");
  });

  // The type icon inside the link destination is vertically centred on the
  // control, so it has to take the same token as the control it sits in.
  test("centres the link icon on the field height", () => {
    const icon = /\.cms-link-icon\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(icon).toContain("height: var(--field-height)");
  });
});

describe("cms.css long text fields", () => {
  // A `text()` field over 120 characters renders a textarea, and the client
  // grows it to its text and only then adds `cms-textarea-grown`. Hiding the
  // scrollbar and dropping the resize handle have to hang off that class: with
  // JavaScript off it never arrives, so a stored long value keeps its normal
  // scrollbar instead of being clipped at three rows.
  test("clips a long text field only once the script has grown it", () => {
    const grown = rules(css).filter(([selector]) =>
      /textarea\.cms-textarea-grown\b/.test(selector),
    );
    expect(grown).toHaveLength(1);
    expect(grown[0]?.[1]).toContain("overflow: hidden");
    expect(grown[0]?.[1]).toContain("resize: none");

    // No rule naming a textarea without the grown class may set either, so the
    // plain three-row textarea a no-JS page renders keeps both.
    for (const [selector, body] of rules(css)) {
      if (!selector.includes("textarea")) continue;
      if (selector.includes("cms-textarea-grown")) continue;
      expect(body).not.toContain("overflow: hidden");
      expect(body).not.toContain("resize: none");
    }
  });

  // The textarea is a text field like any other: the danger border and the
  // focus ring are the input's, not a second look for the long control.
  test("gives a long text field the input's error border", () => {
    const danger = rules(css).find(([selector]) =>
      selector.includes('.cms-field input[aria-invalid="true"]'),
    );
    expect(danger?.[0]).toContain('.cms-field textarea[aria-invalid="true"]');
    expect(danger?.[1]).toContain("border-color: var(--danger)");
  });

  test("gives a long text field the input's focus ring", () => {
    // base.css draws one focus-visible ring for `input, textarea, select`
    // together; this pins that the textarea is still in that group.
    const shared = /input,\s*\ntextarea,\s*\nselect\s*\{([\s\S]*?)\n\}/.exec(
      baseCss,
    )?.[1];
    expect(shared).toContain("&:focus-visible");
    expect(shared).toContain("border-color: var(--accent)");
    expect(shared).toContain("box-shadow: 0 0 0 3px var(--accent-soft)");
  });
});

describe("cms.css optional link fields", () => {
  // An optional link is not an error while it is empty, so its asterisks only
  // appear once the group is in use. Both arms matter: typing into any
  // destination input and picking a page are the two ways the box is filled,
  // and the label/title inputs get blank placeholders for `:placeholder-shown`
  // to read. Hiding with `visibility` keeps the label from shifting.
  test("hides an optional link's asterisks until it is in use", () => {
    const rule = rules(css).find(
      ([selector]) =>
        selector.includes(".cms-field-link-optional") &&
        selector.includes(".cms-required"),
    );
    expect(rule).toBeDefined();

    const selector = (rule?.[0] ?? "").replace(/\s+/g, " ");
    expect(selector).toContain(
      ":has(input[placeholder]:not(:placeholder-shown))",
    );
    expect(selector).toContain(':has(select option:checked:not([value=""]))');
    expect(rule?.[1]).toContain("visibility: hidden");
  });
});

describe("cms.css image picker", () => {
  // A two-line alt (or size line) on a library card took the button's tighter
  // line height, so its lines almost touched. 1.4 is the body value
  // `.cms-field-label` uses.
  test("gives the library card text a body line height", () => {
    for (const selector of [".cms-picker-card-alt", ".cms-picker-card-size"]) {
      const rule = rules(css).find(([name]) => name.trim() === selector);
      expect(rule).toBeDefined();
      expect(rule?.[1]).toMatch(/line-height:\s*1\.4/);
    }
  });

  // The title shrinks to fit beside Close, so a border on the title stopped at
  // the end of the text. The divider belongs to the header row instead, which
  // spans the dialog's content width.
  test("draws the picker's divider across the header row", () => {
    const header = rules(css).find(
      ([name]) => name.trim() === ".cms-picker-header",
    );
    expect(header?.[1]).toContain("border-bottom: 1px solid var(--border)");
    expect(header?.[1]).toContain("padding-bottom: var(--space-3)");

    const title = rules(css).find(
      ([name]) => name.trim() === ".cms-picker-header h2",
    );
    expect(title?.[1]).not.toContain("border");
  });

  // The panel's heading rule used to reach into the picker dialog nested
  // inside it, which is what put the short underline on the title. Narrowed to
  // the panel's own heading with a child combinator, a dialog put in the panel
  // no longer inherits it.
  test("scopes the page-settings heading border to its own heading", () => {
    const bordered = rules(css).filter(
      ([selector, body]) =>
        /\.cms-page-settings\b/.test(selector) &&
        /\bh2\b/.test(selector) &&
        /border-bottom\s*:/.test(body),
    );
    expect(bordered.length).toBeGreaterThan(0);
    for (const [selector] of bordered) {
      expect(selector.trim()).toMatch(/^\.cms-page-settings\s*>\s*h2$/);
    }
  });

  // #107 set the card's padding and gap to 8px (`--space-2`); the line height
  // above must not come with a retuned card.
  test("keeps the library card's 8px padding and gap", () => {
    const card = rules(css).find(
      ([name]) => name.trim() === ".cms-picker-card-button",
    );
    expect(card?.[1]).toContain("gap: var(--space-2)");
    expect(card?.[1]).toContain("padding: var(--space-2)");
  });
});

describe("cms.css media action bar", () => {
  // The media detail form leaves Save at the end of a long phone page — below
  // the focal picker and its three previews. At the phone breakpoint it moves
  // into a bar pinned to the bottom of the viewport, the same pattern as the
  // editors' `.cms-actions`.
  const mobileBlock = /@media\s*\(width <= 640px\)\s*\{([\s\S]*?)\n\}/.exec(
    css,
  );
  const mobile = mobileBlock?.[1] ?? "";

  test("pins the media Save bar to the bottom on a phone", () => {
    const rule = /\.cms-media-actions\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*sticky/);
    expect(rule).toMatch(/bottom:\s*0/);
    // A bar over scrolling pictures needs its own surface and a hairline, or
    // the picker shows through it.
    expect(rule).toContain("background: var(--surface)");
    expect(rule).toContain("border-top: 1px solid var(--border)");
  });

  // The form carries `--space-4` padding at this width; the bar has to cancel
  // it on both sides and at the bottom or its surface floats inside the form
  // rather than reaching the edges.
  test("bleeds the bar across the form's phone padding", () => {
    const rule = /\.cms-media-actions\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? "";
    expect(rule).toMatch(/margin:[^;]*calc\(-1 \* var\(--space-4\)\)/);
    expect(rule).toMatch(/padding:[^;]*env\(safe-area-inset-bottom/);
  });

  // At 1280 Save stays the form's last block in the flow.
  test("leaves the bar in the flow above the phone breakpoint", () => {
    const full = mobileBlock?.[0] ?? "";
    const wide = css.replace(full, "");
    const rule = /\.cms-media-actions\s*\{([^}]*)\}/.exec(wide)?.[1];
    expect(rule ?? "").not.toMatch(/position:\s*sticky/);
  });
});
