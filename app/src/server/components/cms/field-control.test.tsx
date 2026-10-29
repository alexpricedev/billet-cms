import { describe, expect, test } from "bun:test";
import {
  type FieldMetadata,
  MAX_ALT_LENGTH,
} from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import { renderToString } from "preact-render-to-string";
import type { MediaOption } from "../../services/media";
import { MEDIA_PICKER_LIMIT } from "../../services/media/limits";
import {
  FieldControl,
  type FieldError,
  MediaOptionsTemplate,
} from "./field-control";

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
      hasMedia={false}
      pickerCapped={false}
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
    <FieldControl
      hasMedia={false}
      pickerCapped={false}
      field={list}
      value={["one"]}
      idBase="cms-field-tags"
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
        hasMedia={false}
        pickerCapped={false}
        field={list}
        value={["one", "two", "three"]}
        idBase="cms-field-tags"
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
        hasMedia={false}
        pickerCapped={false}
        field={unbounded}
        value={["one"]}
        idBase="cms-field-tags"
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
        hasMedia={false}
        pickerCapped={false}
        field={one}
        value={[]}
        idBase="cms-field-tag"
      />,
    );

    expect(single).toContain("Up to 1 item.");
  });
});

describe("FieldControl image picker", () => {
  const image: FieldMetadata = { name: "photo", kind: "image", required: true };
  const media: MediaOption[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      alt: "A photo",
      width: 800,
      height: 400,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      alt: "B photo",
      width: 1200,
      height: 600,
    },
  ];
  const unlisted = "33333333-3333-4333-8333-333333333333";

  test("renders the reuse list once for the form, not once per field", () => {
    const html = renderToString(
      <div>
        <MediaOptionsTemplate media={media} />
        <FieldControl
          pickerCapped={false}
          field={image}
          value={{ mediaId: media[0].id }}
          idBase="cms-field-photo"
          hasMedia
        />
        <FieldControl
          pickerCapped={false}
          field={image}
          value={{ mediaId: media[1].id }}
          idBase="cms-field-other"
          hasMedia
        />
      </div>,
    );

    // One template for the whole form, so a 400-upload library is not repeated
    // in every image field.
    expect(count(html, "data-media-options")).toBe(1);
    expect(count(html, "B photo (1200×600)")).toBe(1);
  });

  test("each picker shows its current image, even one not in the list", () => {
    const html = renderToString(
      <div>
        <MediaOptionsTemplate media={media} />
        <FieldControl
          pickerCapped={false}
          field={image}
          value={{ mediaId: unlisted, alt: "Stored alt" }}
          idBase="cms-field-photo"
          hasMedia
        />
      </div>,
    );

    // The picker's own option carries the stored alt, is selected (and marked
    // so the client keeps that label), and is the only place that id appears —
    // the template lists other uploads.
    expect(html).toContain(
      `<option value="${unlisted}" selected data-media-keep-label>Stored alt</option>`,
    );
    expect(count(html, `<option value="${unlisted}"`)).toBe(1);
    // Two uploads is below the cap, so the "older ones" help line is not shown.
    expect(html).not.toContain("Showing the newest");
  });

  // A current image the form does not know — deleted, or older than the reuse
  // list — has no alt of its own to show, so it keeps the phrase rather than
  // displaying a raw id.
  test("labels a current image the form doesn't know as 'Current image'", () => {
    const html = renderToString(
      <FieldControl
        pickerCapped={false}
        field={image}
        value={{ mediaId: unlisted }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );

    expect(html).toContain(
      `<option value="${unlisted}" selected>Current image</option>`,
    );
    expect(html).not.toContain(
      `<option value="${unlisted}" selected>${unlisted}</option>`,
    );
  });

  // Part 10: the picker's label describes the image it holds rather than always
  // saying "Current image", so an editor can see which picture is in the field
  // (and how big it is) before opening the picker.
  test("labels a current image the form knows with its alt and dimensions", () => {
    const html = renderToString(
      <FieldControl
        pickerCapped={false}
        field={image}
        media={media}
        value={{ mediaId: media[1].id }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );

    expect(html).toContain(
      `<option value="${media[1].id}" selected data-media-width="1200">B photo (1200×600)</option>`,
    );
    expect(html).not.toContain("Current image");
  });

  // A per-use alt still wins as the label, but the width the field needs for its
  // own warning comes from the upload either way.
  test("keeps the per-use alt on a known upload, and still carries its width", () => {
    const html = renderToString(
      <FieldControl
        pickerCapped={false}
        field={image}
        media={media}
        value={{ mediaId: media[0].id, alt: "Stored alt" }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );

    expect(html).toContain(
      `<option value="${media[0].id}" selected data-media-keep-label data-media-width="800">Stored alt</option>`,
    );
  });

  test("renders the warning slot and the field's minimum width", () => {
    const html = renderToString(
      <FieldControl
        pickerCapped={false}
        field={{ ...image, image: { minWidth: 1600 } }}
        media={media}
        value={{ mediaId: media[0].id }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );

    expect(html).toContain('data-image-min-width="1600"');
    expect(html).toContain("data-image-warning");
    expect(html).toContain("Needs at least 1600px wide");
  });

  // The per-use alt is what the site renders for this use; the marker tells the
  // client's relabel to leave the option's label alone when the picker is
  // focused (see cms-form.ts).
  test("marks the current image's option when it carries a per-use alt", () => {
    const withOverride = renderToString(
      <FieldControl
        pickerCapped={false}
        field={image}
        value={{ mediaId: unlisted, alt: "Stored alt" }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );
    expect(withOverride).toContain(
      `<option value="${unlisted}" selected data-media-keep-label`,
    );

    const without = renderToString(
      <FieldControl
        pickerCapped={false}
        field={image}
        value={{ mediaId: unlisted }}
        idBase="cms-field-photo"
        hasMedia
      />,
    );
    expect(without).not.toContain("data-media-keep-label");
  });

  test("caps the per-use alt override input at the shared limit", () => {
    const html = renderToString(
      <FieldControl
        hasMedia={false}
        pickerCapped={false}
        field={image}
        value={{ mediaId: unlisted, alt: "Stored alt" }}
        idBase="cms-field-photo"
      />,
    );
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

  // The help line is keyed on the controller's `capped`, not on the option
  // count: a library of exactly the limit lists everything, so there is nothing
  // older to paste an id for and the line would be wrong.
  test("shows the reuse help, tied to the picker, only when the list is capped", () => {
    const options: MediaOption[] = Array.from(
      { length: MEDIA_PICKER_LIMIT },
      (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        alt: `Photo ${index}`,
        width: 800,
        height: 400,
      }),
    );
    const render = (pickerCapped: boolean): string =>
      renderToString(
        <div>
          <MediaOptionsTemplate media={options} />
          <FieldControl
            field={image}
            value={{ mediaId: options[0].id, alt: "First" }}
            idBase="cms-field-photo"
            hasMedia
            pickerCapped={pickerCapped}
          />
        </div>,
      );

    const capped = render(true);
    expect(capped).toContain("Showing the newest 50 uploads");
    expect(capped).toContain('id="cms-field-photo-pick-help"');
    expect(capped).toContain('aria-describedby="cms-field-photo-pick-help"');

    // The same list, an uncapped library: no help line, and the picker points
    // at nothing it does not have.
    const uncapped = render(false);
    expect(uncapped).not.toContain("Showing the newest");
    expect(uncapped).not.toContain('id="cms-field-photo-pick-help"');
    expect(uncapped).not.toContain(
      'aria-describedby="cms-field-photo-pick-help"',
    );
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
        hasMedia={false}
        pickerCapped={false}
        field={link}
        value={value}
        idBase="cms-field-cta"
        pages={[{ id: PAGE_ID, title: "About", url: "/about" }]}
        errors={errors}
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
        hasMedia={false}
        pickerCapped={false}
        field={links}
        idBase="cms-field-links"
        value={[
          { type: "url", url: "https://a.example", label: "A" },
          { type: "url", url: "https://b.example", label: "B" },
        ]}
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
        hasMedia={false}
        pickerCapped={false}
        field={field}
        value={field.kind === "image" ? {} : ""}
        errors={errors}
        idBase="cms-field-x"
      />,
    );
  const mediaIdInput = (html: string): string =>
    html.match(/<input[^>]*data-image-id[^>]*>/)?.[0] ?? "";

  test("image inputs carry no placeholder", () => {
    const html = render({ name: "x", kind: "image", required: false });
    expect(html).not.toContain("placeholder=");
  });

  test("Media id names no ids without help or errors", () => {
    const input = mediaIdInput(
      render({ name: "x", kind: "image", required: false }),
    );
    expect(input).not.toContain("aria-describedby");
  });

  test("Media id names help only with help, error only with errors", () => {
    const help = mediaIdInput(
      render({ name: "x", kind: "image", required: false, help: "Pick" }),
    );
    expect(help).toContain('aria-describedby="cms-field-x-help"');
    const err = mediaIdInput(
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
