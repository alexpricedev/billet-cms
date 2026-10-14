import { describe, expect, test } from "bun:test";
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import { renderToString } from "preact-render-to-string";
import { FieldControl } from "./field-control";

const emptyDocument: RichTextDocument = { type: "doc", content: [] };

const richText: FieldMetadata = {
  name: "body",
  kind: "richText",
  required: true,
};

/**
 * Count how many times an exact attribute appears. A duplicate id is the bug:
 * `getElementById` and a label's `for` both resolve to whichever the browser
 * saw last, so the fieldset and the editor must not share one.
 */
const count = (html: string, needle: string): number =>
  html.split(needle).length - 1;

describe("FieldControl rich text", () => {
  const html = renderToString(
    <FieldControl
      field={richText}
      value={emptyDocument}
      idBase="cms-field-body"
    />,
  );

  test("gives the editor the id, not the fieldset", () => {
    expect(count(html, 'id="cms-field-body"')).toBe(1);
  });

  // The editor is the textbox and needs its own name; the legend labels it.
  test("names the editor from the legend", () => {
    expect(html).toContain('id="cms-field-body-label"');
    expect(html).toContain('aria-labelledby="cms-field-body-label"');
    expect(html).toContain('role="textbox"');
  });
});

describe("FieldControl list", () => {
  const list: FieldMetadata = {
    name: "tags",
    kind: "list",
    label: "Tags",
    required: false,
    max: 3,
    of: { name: "item", kind: "text", required: true },
  };

  const html = renderToString(
    <FieldControl field={list} value={["one"]} idBase="cms-field-tags" />,
  );

  // The template row is cloned, so a number baked into it would say "Item 1"
  // for every added row. Naming by the list's label instead is stable.
  test("names added rows by the list, not a repeated row number", () => {
    expect(html).not.toContain("Item 1");
    expect(html).toContain('aria-label="Tags"');
  });

  test("names each Add and Remove after the list it belongs to", () => {
    expect(html).toContain('aria-label="Add to Tags"');
    expect(html).toContain('aria-label="Remove from Tags"');
  });

  test("spells out the maximum in the help text", () => {
    expect(html).toContain("Up to 3 items.");
  });

  test("disables Add when the stored list is already at its maximum", () => {
    const full = renderToString(
      <FieldControl
        field={list}
        value={["one", "two", "three"]}
        idBase="cms-field-tags"
      />,
    );
    const add = /<button[^>]*data-list-add[^>]*>/.exec(full)?.[0] ?? "";

    expect(add).toContain("disabled");
  });

  test("uses the singular for a one-item maximum", () => {
    const one: FieldMetadata = {
      name: "tag",
      kind: "list",
      required: false,
      max: 1,
      of: { name: "item", kind: "text", required: true },
    };
    const single = renderToString(
      <FieldControl field={one} value={[]} idBase="cms-field-tag" />,
    );

    expect(single).toContain("Up to 1 item.");
  });
});

describe("FieldControl link", () => {
  test("marks its inputs invalid and points them at the error", () => {
    const link: FieldMetadata = { name: "cta", kind: "link", required: true };
    const html = renderToString(
      <FieldControl
        field={link}
        value={{ type: "url", url: "not a url" }}
        idBase="cms-field-cta"
        errors={[{ path: "cta", message: "This value isn't valid." }]}
      />,
    );

    expect(html).toContain('id="cms-field-cta-url"');
    expect(html).toContain('id="cms-field-cta-error"');
    // The help id is included even when a field has no help text, so point at
    // the error within the list rather than asserting the whole attribute.
    expect(html).toMatch(/aria-describedby="[^"]*cms-field-cta-error/);
    expect(html).toContain('aria-invalid="true"');
  });

  test("marks nothing invalid when there are no errors", () => {
    const link: FieldMetadata = { name: "cta", kind: "link", required: true };
    const html = renderToString(
      <FieldControl
        field={link}
        value={{ type: "url", url: "https://example.com" }}
        idBase="cms-field-cta"
      />,
    );

    expect(html).not.toContain('aria-invalid="true"');
  });
});
