import { describe, expect, test } from "bun:test";
import {
  type FieldMetadata,
  MAX_ALT_LENGTH,
} from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import { renderToString } from "preact-render-to-string";
import { FieldControl, type FieldError } from "./field-control";
import type { PickerImage } from "./image-picker";

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
      uploadCsrfToken="upload-token"
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

describe("FieldControl text", () => {
  const renderText = (
    max: number | undefined,
    value = "",
    errors?: FieldError[],
  ): string =>
    renderToString(
      <FieldControl
        field={{ name: "intro", kind: "text", required: false, max }}
        value={value}
        errors={errors}
        idBase="cms-field-intro"
        uploadCsrfToken="upload-token"
      />,
    );
  const control = (html: string): string =>
    html.match(/<(?:input|textarea)[^>]*data-text-input[^>]*>/)?.[0] ?? "";

  // A long field is a three-row textarea from the start; the label, id and
  // count wiring are the input's, so the client and the counter keep working.
  test("renders a textarea above 120 characters", () => {
    const html = renderText(400);
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(control(html)).toContain('rows="3"');
    expect(control(html)).toContain('id="cms-field-intro"');
  });

  test("renders an input at 120 characters or with no maximum", () => {
    for (const max of [120, undefined]) {
      const html = renderText(max);
      expect(html).toContain('<input type="text"');
      expect(html).not.toContain("<textarea");
    }
  });

  // The count lives in the field's help line, the same as for an input; the
  // textarea points at it and at the field's help, never at a missing id.
  test("keeps the character counter and its aria wiring on the textarea", () => {
    const html = renderText(400, "Hello");
    expect(html).toContain("5 / 400");
    expect(html).toContain("data-char-count");
    expect(html).toContain('data-char-max="400"');
    expect(control(html)).toContain('aria-describedby="cms-field-intro-count"');
    expect(html).toContain('id="cms-field-intro-count"');
  });

  // The counter used to take a row of its own below the box, which read as a
  // wider gap before the next field. It sits at the end of the label row now,
  // above the control, and the control keeps pointing at it.
  test("keeps the character counter inside the label row", () => {
    const html = renderText(120, "Hello");
    const row =
      /<div class="cms-field-label-row">([\s\S]*?)<\/div>/.exec(html)?.[1] ??
      "";

    expect(row).toContain('class="cms-field-label"');
    expect(row).toContain("5 / 120");
    expect(row).toContain("data-char-count");
    expect(row).toContain('data-char-max="120"');
    expect(row).toContain('id="cms-field-intro-count"');
    // Above the box, not below it.
    expect(html.indexOf("cms-field-label-row")).toBeLessThan(
      html.indexOf("data-text-input"),
    );
    expect(control(html)).toContain('aria-describedby="cms-field-intro-count"');
  });

  test("puts a label-overridden field's counter on the label row too", () => {
    const html = renderToString(
      <FieldControl
        field={{ name: "item", kind: "text", required: false, max: 80 }}
        value="Hi"
        labelOverride="Tag"
        nameScope="tag-0"
        uploadCsrfToken="upload-token"
      />,
    );
    const row =
      /<div class="cms-field-label-row">([\s\S]*?)<\/div>/.exec(html)?.[1] ??
      "";

    expect(row).toContain('class="cms-field-label">Tag<');
    expect(row).toContain("2 / 80");
    expect(row).toContain("data-char-count");
  });

  // The flex row is only for a field with a counter. Without one the label
  // stays a direct grid child, so it spans the row and the whole line focuses
  // the control, as it did before the counter moved.
  test("leaves a field without a counter's label unwrapped", () => {
    const html = renderText(undefined);
    expect(html).not.toContain("cms-field-label-row");
    expect(html).toContain(
      '<label class="cms-field-label" for="cms-field-intro">',
    );
  });

  test("carries help, errors and the invalid state on the textarea", () => {
    const html = renderToString(
      <FieldControl
        field={{
          name: "intro",
          kind: "text",
          required: true,
          max: 400,
          help: "Keep it short.",
        }}
        value="Hello"
        errors={[{ path: "intro", message: "Too long." }]}
        idBase="cms-field-intro"
        uploadCsrfToken="upload-token"
      />,
    );
    const textarea = control(html);

    expect(textarea).toContain('aria-required="true"');
    expect(textarea).toContain('aria-invalid="true"');
    expect(textarea).toContain(
      'aria-describedby="cms-field-intro-help cms-field-intro-error cms-field-intro-count"',
    );
    // Stored text is the textarea's content, so the long value arrives with it.
    expect(html).toContain(">Hello</textarea>");
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
    <FieldControl
      field={list}
      value={["one"]}
      idBase="cms-field-tags"
      uploadCsrfToken="upload-token"
    />,
  );

  // The template row is cloned, so a number baked into it would say "Item 1"
  // for every added row. Naming by the list's label instead is stable.
  test("names added rows by the list, not a repeated row number", () => {
    expect(html).not.toContain("Item 1");
    expect(html).toContain('aria-label="Tags"');
  });

  test("names each Add and Remove after the list it belongs to", () => {
    expect(html).toContain('aria-label="Add item to Tags"');
    expect(html).toContain('aria-label="Remove from Tags"');
    // The visible text stays short; only the accessible name names the list.
    expect(html).toContain(">Add item<");
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
        uploadCsrfToken="upload-token"
      />,
    );
    const add = /<button[^>]*data-list-add[^>]*>/.exec(full)?.[0] ?? "";

    // `aria-disabled`, not `disabled`: the client keeps the element clickable
    // and guards the click, so the state is announced but not enforced by the
    // browser alone. (`aria-disabled="..."` contains the substring, so check for
    // the attribute proper.)
    expect(add).toContain('aria-disabled="true"');
    expect(add).not.toContain(" disabled");
    expect(add).not.toContain("disabled>");
    // And the limit lives in the help text the button points at.
    expect(add).toContain('aria-describedby="cms-field-tags-help"');
    expect(full).toContain('id="cms-field-tags-help"');
  });

  test("leaves Add enabled and unlinked to help when there is no maximum", () => {
    const unbounded: FieldMetadata = {
      name: "tags",
      kind: "list",
      required: false,
      of: { name: "item", kind: "text", required: true },
    };
    const html = renderToString(
      <FieldControl
        field={unbounded}
        value={["one"]}
        idBase="cms-field-tags"
        uploadCsrfToken="upload-token"
      />,
    );
    const add = /<button[^>]*data-list-add[^>]*>/.exec(html)?.[0] ?? "";

    expect(add).not.toContain("aria-disabled");
    expect(add).not.toContain("aria-describedby");
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
      <FieldControl
        field={one}
        value={[]}
        idBase="cms-field-tag"
        uploadCsrfToken="upload-token"
      />,
    );

    expect(single).toContain("Up to 1 item.");
  });
});

describe("FieldControl image picker", () => {
  const image: FieldMetadata = { name: "photo", kind: "image", required: true };
  const first: PickerImage = {
    id: "11111111-1111-4111-8111-111111111111",
    alt: "A photo",
    width: 800,
    height: 400,
    thumbnailUrl: "https://cdn.example.test/a-192.webp",
  };
  const second: PickerImage = {
    id: "22222222-2222-4222-8222-222222222222",
    alt: "B photo",
    width: 1200,
    height: 600,
    thumbnailUrl: null,
  };
  const unlisted = "33333333-3333-4333-8333-333333333333";
  const pickerImages = new Map<string, PickerImage>([
    [first.id, first],
    [second.id, second],
  ]);

  const renderImage = (
    value: unknown,
    {
      field = image,
      idBase = "cms-field-photo",
      images = pickerImages,
    }: {
      field?: FieldMetadata;
      idBase?: string;
      images?: Map<string, PickerImage>;
    } = {},
  ): string =>
    renderToString(
      <FieldControl
        field={field}
        value={value}
        idBase={idBase}
        pickerImages={images}
        uploadCsrfToken="upload-token"
      />,
    );

  // The shared picker is the field's control now: the server draws its closed
  // state from the upload the stored content names, and the client brings the
  // dialog to life. One picker per field wherever the field sits.
  test("renders the shared picker with the current upload", () => {
    const html = renderImage({ mediaId: first.id });
    const fieldset =
      html.match(/<fieldset[^>]*data-image-picker-field[^>]*>/)?.[0] ?? "";

    expect(fieldset).toContain('class="cms-field cms-image-picker"');
    expect(fieldset).toContain('data-image-picker-csrf="upload-token"');
    // The stored width travels with the picker so the field can warn before the
    // editor touches it.
    expect(fieldset).toContain(`data-image-picker-width="${first.width}"`);
    // A block field is cloned from a `<template>`; an id prefix here would be
    // repeated in every copy, so the picker renders none.
    expect(html).not.toContain("cms-image-picker-cms-field-photo");
    expect(html).toContain(`src="${first.thumbnailUrl}"`);
    expect(html).toContain(">A photo</span>");
    expect(html).toContain(">800×400</span>");
    expect(html).toContain(`value="${first.id}"`);
  });

  test("renders one picker per image field, not a shared reuse list", () => {
    const html = renderToString(
      <div>
        <FieldControl
          field={image}
          value={{ mediaId: first.id }}
          idBase="cms-field-photo"
          pickerImages={pickerImages}
          uploadCsrfToken="upload-token"
        />
        <FieldControl
          field={image}
          value={{ mediaId: second.id }}
          idBase="cms-field-other"
          pickerImages={pickerImages}
          uploadCsrfToken="upload-token"
        />
      </div>,
    );

    expect(count(html, "data-image-picker-field")).toBe(2);
    expect(html).toContain("A photo");
    expect(html).toContain("B photo");
    expect(html).not.toContain("data-media-options");
    expect(html).not.toContain("Reuse an upload");
  });

  // The hidden input is the JavaScript-off path and the client's value: it
  // carries the stored id, and it is hidden — the raw Media id box is gone.
  test("carries the chosen id in a hidden input, with no Media id box", () => {
    const html = renderImage({ mediaId: first.id });
    const input = html.match(/<input[^>]*data-image-id[^>]*>/)?.[0] ?? "";

    expect(input).toContain('type="hidden"');
    expect(input).toContain(`value="${first.id}"`);
    expect(input).not.toContain('type="text"');
    expect(html).not.toContain("Media id");
  });

  test("shows the empty closed state when nothing is chosen", () => {
    const html = renderImage({ mediaId: "" });

    expect(html).toContain("No image chosen.");
    expect(html).not.toContain("Upload not found");
  });

  // An id with no row is an upload that no longer exists. Saying "No image
  // chosen." over a value a save will still validate would hide the problem.
  test("says 'Upload not found' for a stored id with no upload", () => {
    const html = renderImage({ mediaId: unlisted });

    expect(html).toContain("Upload not found");
    expect(html).not.toContain("No image chosen.");
    expect(html).toContain(`value="${unlisted}"`);
  });

  test("renders the warning slot and the field's minimum width", () => {
    const html = renderImage(
      { mediaId: first.id },
      { field: { ...image, image: { minWidth: 1600 } } },
    );

    expect(html).toContain('data-image-min-width="1600"');
    expect(html).toContain("data-image-warning");
    expect(html).toContain("Needs at least 1600px wide");
  });

  test("caps the per-use alt override input at the shared limit", () => {
    const html = renderImage({ mediaId: unlisted, alt: "Stored alt" });
    const alt = /<input[^>]*data-image-alt[^>]*>/.exec(html)?.[0] ?? "";

    // Preact lower-cases the attribute in the rendered HTML.
    expect(alt).toContain(`maxlength="${MAX_ALT_LENGTH}"`);
    // The limit is described to the control, not just enforced by the browser's
    // maxlength, so a screen reader hears why the field stops at 1000.
    expect(alt).toContain('aria-describedby="cms-field-photo-alt-help"');
    expect(html).toContain('id="cms-field-photo-alt-help"');
    expect(html).toContain(
      `Optional. Leave blank to use the upload's own alt text. Up to ${MAX_ALT_LENGTH} characters.`,
    );
  });
});

describe("FieldControl image parts", () => {
  const image: FieldMetadata = { name: "photo", kind: "image", required: true };

  const renderImage = ({
    help,
    errors,
    labelOverride,
  }: {
    help?: string;
    errors?: FieldError[];
    labelOverride?: string;
  } = {}): string =>
    renderToString(
      <FieldControl
        field={help ? { ...image, help } : image}
        value={{ mediaId: "11111111-1111-4111-8111-111111111111" }}
        idBase="cms-field-photo"
        pickerImages={new Map()}
        uploadCsrfToken="upload-token"
        errors={errors}
        labelOverride={labelOverride}
      />,
    );

  // A part ends at its own closing div: nothing inside one nests another div.
  const parts = (html: string): string[] =>
    html
      .split('<div class="cms-image-part">')
      .slice(1)
      .map((part) => part.split("</div>")[0]);

  // #110's layout stays: the picker and Alt text are the two parts, spaced
  // like separate fields inside one wrapper.
  test("groups the picker and Alt text in one wrapper", () => {
    const html = renderImage();
    expect(count(html, 'class="cms-image-parts"')).toBe(1);
    expect(count(html, "data-image-picker-field")).toBe(1);
    expect(parts(html)).toHaveLength(1);
  });

  test("keeps the Alt text sub-label with its control", () => {
    const [alt] = parts(renderImage());

    expect(alt).toContain('for="cms-field-photo-alt"');
    expect(alt).toContain("data-image-alt");
  });

  // The picker's own legend is visually hidden, so the field's heading ("Photo"
  // or a list row's label) is the only visible one; the accessible name stays.
  test("hides the picker's legend behind the field's own heading", () => {
    const html = renderImage();

    expect(html).toContain('<legend class="cms-field-label sr-only"');
    expect(html).toContain(">photo</legend>");
    expect(count(html, 'class="cms-field-label"')).toBe(1);
  });

  // The wrapper's and help line's spacing classes carry the heading rhythm:
  // a legend is outside the fieldset's grid (so help under it needs the 6px),
  // while a list row's span label is a grid item (so it must not double it).
  test("marks the wrapper and heading help for the label they follow", () => {
    const legend = renderImage({ help: "A photo." });
    expect(legend).toContain(
      'class="cms-image-parts cms-image-parts-after-help"',
    );
    expect(legend).toContain('class="cms-field-help cms-image-help"');

    const span = renderImage({ help: "A photo.", labelOverride: "Images" });
    expect(span).toContain(
      'class="cms-image-parts cms-image-parts-after-label cms-image-parts-after-help"',
    );
    expect(span).not.toContain("cms-image-help");
  });

  // The field's own help, errors and the min-width note describe the field as
  // a whole, not a part, so they stay direct children of the fieldset.
  test("leaves the field's own help and errors outside the parts", () => {
    const html = renderImage({
      help: "A photo.",
      errors: [{ path: "photo", message: "Choose an image." }],
    });
    const inside = parts(html).join("");

    expect(inside).not.toContain('id="cms-field-photo-help"');
    expect(inside).not.toContain('id="cms-field-photo-error"');
    expect(html).toContain('id="cms-field-photo-help"');
    expect(html).toContain('id="cms-field-photo-error"');
  });
});
describe("FieldControl link", () => {
  const PAGE_ID = "22222222-2222-4222-8222-222222222222";
  const link: FieldMetadata = {
    name: "cta",
    kind: "link",
    label: "Primary button",
    required: true,
  };
  const renderLink = (value: unknown, errors?: FieldError[]): string =>
    renderToString(
      <FieldControl
        field={link}
        value={value}
        idBase="cms-field-cta"
        pages={[{ id: PAGE_ID, title: "About", url: "/about" }]}
        errors={errors}
        uploadCsrfToken="upload-token"
      />,
    );

  test("is one container with button text, a type switch and hover text", () => {
    const html = renderLink({
      type: "url",
      url: "https://example.com",
      label: "Go",
    });

    // The field's own label heads the box, and Button text comes first.
    expect(html).toContain('class="cms-field cms-field-link"');
    expect(html).toContain("Primary button");
    expect(html).toContain("data-link-label");
    expect(html).toContain('value="Go"');

    // A real radio group with all four destinations.
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Link type"');
    expect(count(html, 'type="radio"')).toBe(4);
    for (const kind of ["url", "page", "email", "phone"]) {
      expect(html).toContain(`data-link-destination="${kind}"`);
    }

    // All four destination controls render, each with its own type; CSS shows
    // the one whose radio is checked. The URL box is `type="text"` so a stored
    // root-relative path or fragment isn't refused by native validation.
    expect(html).toMatch(/type="text"[^>]*data-link-url/);
    expect(html).not.toContain('type="url"');
    expect(html).toContain('placeholder="https://…"');
    expect(html).toContain("data-link-page");
    expect(html).toContain('type="email"');
    expect(html).toContain('placeholder="name@example.com"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('placeholder="+44 20 7946 0000"');

    // New tab, divider, then Hover text with its hint.
    expect(html).toContain("data-link-newtab");
    expect(html).toContain("Open in a new tab");
    expect(html).toContain('class="cms-link-divider"');
    expect(html).toContain("data-link-title");
    expect(html).toContain(
      "Shown as a tooltip when someone hovers over the link.",
    );

    // One required marker for the whole group, on its heading: the sub-labels
    // inside it carry none, or they read as a second label for Button text.
    expect(html).toMatch(
      /<legend class="cms-field-label">Primary button<span class="cms-required"> \*<\/span><\/legend>/,
    );
    expect(count(html, 'class="cms-required"')).toBe(1);
    expect(html).toContain("Button text");
    expect(html).not.toContain("Button text<span");
    expect(html).not.toContain(">Goes to<span");
    // A required link's asterisk does not wait to be used.
    expect(html).not.toContain("cms-field-link-optional");
  });

  // Every link with a destination renders its own Button text, wherever it
  // sits: a text field beside it in the same group is a different control.
  test("renders Button text on a link inside a group", () => {
    const group: FieldMetadata = {
      name: "cta",
      kind: "group",
      label: "Call to action",
      required: true,
      fields: [
        { name: "text", kind: "text", required: true },
        { name: "link", kind: "link", required: true },
      ],
    };
    const html = renderToString(
      <FieldControl
        field={group}
        value={{
          text: "Read more",
          link: { type: "url", url: "https://example.com" },
        }}
        idBase="cms-field-cta"
        uploadCsrfToken="upload-token"
      />,
    );

    expect(html).toContain("data-link-label");
    expect(html).toContain("Button text");
  });

  // A group's heading owns its one marker. Its children never repeat it: two
  // asterisks stacked over the first control read as two labels for one input.
  test("a group's heading carries the only required marker", () => {
    const group: FieldMetadata = {
      name: "cta",
      kind: "group",
      label: "Call to action",
      required: true,
      fields: [
        { name: "heading", kind: "text", required: true },
        { name: "link", kind: "link", required: true },
      ],
    };
    const html = renderToString(
      <FieldControl
        field={group}
        value={{ heading: "Hi", link: { type: "url", url: "https://a.test" } }}
        idBase="cms-field-cta"
        uploadCsrfToken="upload-token"
      />,
    );

    // The heading's star, and none on "Heading" or the link's "Goes to".
    expect(count(html, 'class="cms-required"')).toBe(1);
    expect(html).toMatch(
      /<legend class="cms-field-label">Call to action<span class="cms-required"> \*<\/span><\/legend>/,
    );
    expect(html).toContain(">heading<");
  });

  // An optional group says so on its heading, and nothing on its parts.
  test("an optional group heading says Optional with no asterisk", () => {
    const group: FieldMetadata = {
      name: "cta",
      kind: "group",
      label: "Call to action",
      required: false,
      fields: [{ name: "heading", kind: "text", required: true }],
    };
    const html = renderToString(
      <FieldControl
        field={group}
        value={{ heading: "Hi" }}
        idBase="cms-field-cta"
        uploadCsrfToken="upload-token"
      />,
    );

    expect(html).toMatch(
      /Call to action<span class="cms-field-optional"> Optional<\/span>/,
    );
    expect(count(html, 'class="cms-required"')).toBe(0);
  });

  // An optional link is optional as a whole, so its heading says "Optional"
  // until the box is in use and only then carries the asterisk. The swap is
  // CSS: mark the field and give the text inputs a placeholder, so
  // `:placeholder-shown` can tell empty from typed.
  test("marks an optional link and its text inputs for the in-use rule", () => {
    const html = renderToString(
      <FieldControl
        field={{ ...link, required: false }}
        value={{}}
        idBase="cms-field-cta"
        uploadCsrfToken="upload-token"
      />,
    );

    expect(html).toContain("cms-field-link-optional");
    expect(html).toMatch(/data-link-label[^>]*placeholder=" "/);
    expect(html).toMatch(/data-link-title[^>]*placeholder=" "/);
    // The heading owns both markers; the parts carry none.
    expect(html).toMatch(
      /Primary button<span class="cms-required"> \*<\/span><span class="cms-field-optional"> Optional<\/span>/,
    );
    expect(html).not.toContain("Button text<span");
    expect(html).not.toContain(">Goes to<span");
  });

  // Each row is its own link. Sharing a radio `name` would make choosing a type
  // in one row uncheck it in the next, because the browser groups by name.
  test("gives a link in each list row its own radio group name", () => {
    const links: FieldMetadata = {
      name: "links",
      kind: "list",
      required: false,
      of: { name: "link", kind: "link", required: true },
    };
    const html = renderToString(
      <FieldControl
        field={links}
        idBase="cms-field-links"
        value={[
          { type: "url", url: "https://a.example", label: "A" },
          { type: "url", url: "https://b.example", label: "B" },
        ]}
        uploadCsrfToken="upload-token"
      />,
    );

    const names = Array.from(
      html.matchAll(/type="radio"[^>]*name="([^"]+)"/g),
      (match) => match[1],
    );
    // Two real rows plus the template row the client clones: one name each,
    // and every one of them used by its own four options.
    const unique = Array.from(new Set(names));
    expect(unique.filter((name) => !name.includes("template"))).toHaveLength(2);
    for (const name of unique) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(4);
    }
  });

  // A list row's heading is the list's name, not the link's, but the marker
  // belongs to the link control the row renders. Its sub-labels carry none, so
  // without the heading's star a required link in a list shows no marker at all.
  test("a required link in a list row carries its marker on the row heading", () => {
    const links: FieldMetadata = {
      name: "links",
      kind: "list",
      required: false,
      of: { name: "link", kind: "link", required: true },
    };
    const html = renderToString(
      <FieldControl
        field={links}
        idBase="cms-field-links"
        value={[{ type: "url", url: "https://a.example", label: "A" }]}
        uploadCsrfToken="upload-token"
      />,
    );

    expect(html).toContain(
      '<span class="cms-field-label">links<span class="cms-required"> *</span></span>',
    );
    expect(html).not.toContain("Button text<span");
    expect(html).not.toContain(">Goes to<span");
  });

  // A URL-rendered link has no page picker, so an error keyed `pageId` has no
  // control of its own. It is still an issue the editor was refused over, so it
  // goes on the container rather than being dropped as "known".
  test("shows a non-selected destination error on the container", () => {
    const html = renderLink(
      { type: "url", url: "https://example.com", label: "Go" },
      [{ path: "cta.pageId", message: "Choose a page." }],
    );

    expect(html).toContain('id="cms-field-cta-error"');
    expect(html).toContain("Choose a page.");
    expect(html).not.toMatch(/data-link-url[^>]*aria-invalid/);
  });

  // Rendered outside `ContentFields` a link has neither an id nor a row scope.
  // Two links with the same field name must still not become one browser-side
  // radio group, or choosing a type in one changes the other.
  test("keeps two unscoped same-named links in separate radio groups", () => {
    const renderUnscoped = (): string =>
      renderToString(
        <FieldControl
          field={link}
          value={{}}
          labelOverride="Link"
          uploadCsrfToken="upload-token"
        />,
      );

    const names = Array.from(
      `${renderUnscoped()}${renderUnscoped()}`.matchAll(
        /type="radio"[^>]*name="([^"]+)"/g,
      ),
      (match) => match[1],
    );
    const unique = Array.from(new Set(names));
    expect(unique).toHaveLength(2);
    for (const name of unique) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(4);
    }
  });

  test("checks the stored type, including mailto and tel", () => {
    const checkedRadio = (html: string): string =>
      html.match(/<input[^>]*type="radio"[^>]*checked[^>]*>/)?.[0] ?? "";

    expect(
      checkedRadio(renderLink({ type: "url", url: "https://example.com" })),
    ).toContain('value="url"');
    expect(
      checkedRadio(renderLink({ type: "page", pageId: PAGE_ID })),
    ).toContain('value="page"');
    const email = renderLink({ type: "url", url: "mailto:hi@example.com" });
    expect(checkedRadio(email)).toContain('value="email"');
    // The address is shown without its scheme; switching back re-adds it.
    expect(email).toMatch(/data-link-email[^>]*value="hi@example.com"/);
    const phone = renderLink({ type: "url", url: "tel:+442079460000" });
    expect(checkedRadio(phone)).toContain('value="phone"');
    expect(phone).toMatch(/data-link-phone[^>]*value="\+442079460000"/);
  });

  test("puts a button-text error under button text and marks only it", () => {
    const html = renderLink({ type: "url", url: "https://example.com" }, [
      { path: "cta.label", message: "Button text is required." },
    ]);

    expect(html).toContain('id="cms-field-cta-label-error"');
    expect(html).toMatch(
      /data-link-label[^>]*aria-invalid="true"[^>]*aria-describedby="cms-field-cta-label-error"/,
    );
    // The URL input is fine and keeps no invalid state.
    expect(html).toMatch(/data-link-url(?![^>]*aria-invalid)/);
  });

  test("puts a URL error under the URL input", () => {
    const html = renderLink({ type: "url", url: "not a url" }, [
      { path: "cta.url", message: "Enter a full URL, starting with https://" },
    ]);

    expect(html).toContain("Enter a full URL, starting with https://");
    expect(html).toContain('id="cms-field-cta-destination-error"');
    expect(html).toMatch(
      /data-link-url[^>]*aria-invalid="true"[^>]*aria-describedby="cms-field-cta-destination-error"/,
    );
    expect(html).not.toMatch(/data-link-label[^>]*aria-invalid/);
  });

  test("puts a page error under the page picker", () => {
    const html = renderLink({ type: "page" }, [
      { path: "cta.pageId", message: "Choose a page." },
    ]);

    expect(html).toContain("Choose a page.");
    expect(html).toMatch(
      /data-link-page[^>]*aria-invalid="true"[^>]*aria-describedby="cms-field-cta-destination-error"/,
    );
  });

  test("keeps a whole-link error on the container", () => {
    const html = renderLink(
      { type: "url", url: "https://example.com", label: "Go" },
      [{ path: "cta", message: "This value isn't valid." }],
    );

    expect(html).toContain('id="cms-field-cta-error"');
    expect(html).toContain("This value isn't valid.");
    expect(html).not.toContain('aria-invalid="true"');
  });

  test("marks nothing invalid when there are no errors", () => {
    const html = renderLink({
      type: "url",
      url: "https://example.com",
      label: "Go",
    });

    expect(html).not.toContain('aria-invalid="true"');
  });
});

describe("FieldControl described-by ids", () => {
  const render = (field: FieldMetadata, errors?: FieldError[]): string =>
    renderToString(
      <FieldControl
        field={field}
        value={field.kind === "image" ? {} : ""}
        errors={errors}
        idBase="cms-field-x"
        uploadCsrfToken="upload-token"
      />,
    );
  const imageField = (html: string): string =>
    html.match(/<fieldset[^>]*data-field-kind="image"[^>]*>/)?.[0] ?? "";

  test("the picker's value input carries no placeholder", () => {
    const html = render({ name: "x", kind: "image", required: false });
    const input = html.match(/<input[^>]*data-image-id[^>]*>/)?.[0] ?? "";

    expect(input).not.toContain("placeholder=");
  });

  test("an image field names no ids without help or errors", () => {
    const field = imageField(
      render({ name: "x", kind: "image", required: false }),
    );
    expect(field).not.toContain("aria-describedby");
  });

  test("an image field names help only with help, error only with errors", () => {
    const help = imageField(
      render({ name: "x", kind: "image", required: false, help: "Pick" }),
    );
    expect(help).toContain('aria-describedby="cms-field-x-help"');
    const err = imageField(
      render({ name: "x", kind: "image", required: false }, [
        { path: "", message: "Bad" },
      ]),
    );
    expect(err).toContain('aria-describedby="cms-field-x-error"');
  });

  test("a text field names no ids without help or errors", () => {
    const html = render({ name: "x", kind: "text", required: false });
    expect(html).not.toContain("aria-describedby");
  });
});
