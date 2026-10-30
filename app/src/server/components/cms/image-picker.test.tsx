import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { ImagePicker, type PickerImage } from "./image-picker";

const IMAGE: PickerImage = {
  id: "11111111-1111-4111-8111-111111111111",
  alt: "A wooden pier at dusk",
  width: 1600,
  height: 900,
  thumbnailUrl: "https://cdn.example.test/pier-192.webp",
};

const render = (
  props: Partial<Parameters<typeof ImagePicker>[0]> = {},
): string =>
  renderToString(
    <ImagePicker
      name="socialImageId"
      label="Social image"
      value={null}
      uploadCsrfToken="upload-token"
      {...props}
    />,
  );

const tag = (html: string, attribute: string): string =>
  new RegExp(`<[^>]*${attribute}[^>]*>`).exec(html)?.[0] ?? "";

describe("ImagePicker", () => {
  // The field is a form control first: with JavaScript off this hidden input is
  // the entire behaviour, and it must submit whatever the server stored.
  test("carries the chosen id in one hidden input named for the field", () => {
    const html = render({ value: IMAGE.id, image: IMAGE });
    const input = tag(html, "data-image-picker-value");

    expect(input).toContain('type="hidden"');
    expect(input).toContain(`name="socialImageId"`);
    expect(input).toContain(`value="${IMAGE.id}"`);
    // One hidden input, not one per directive; the field's own data attribute
    // also ends in `-name`, so match the input tag rather than the substring.
    expect(html.match(/<input[^>]*name="socialImageId"[^>]*>/g)).toHaveLength(
      1,
    );
  });

  test("submits an empty string when nothing is chosen", () => {
    const input = tag(render(), "data-image-picker-value");
    expect(input).toContain('name="socialImageId"');
    // Preact renders an empty string value as the bare attribute, which submits
    // as the empty string — the same thing a plain `value=""` would.
    expect(input).toMatch(/value(?:="")?\s/);
  });

  test("names its fieldset from the label and carries the upload token", () => {
    const field = tag(render(), "data-image-picker-field");

    expect(field).toContain('class="cms-field cms-image-picker"');
    expect(field).toContain('data-image-picker-csrf="upload-token"');
    expect(field).toContain('data-image-picker-name="socialImageId"');
    expect(render()).toContain(
      '<legend class="cms-field-label" id="cms-image-picker-socialImageId-label">Social image</legend>',
    );
  });

  // An empty field still shows the closed state — a grey tile and a phrase —
  // so the control never renders as a gap of nothing.
  test("shows the empty closed state with Remove hidden", () => {
    const html = render();

    expect(html).toContain("No image chosen.");
    expect(tag(html, "data-image-picker-thumb")).toContain("hidden");
    expect(tag(html, "data-image-picker-thumb")).not.toContain("src=");
    expect(tag(html, "data-image-picker-remove")).toContain("hidden");
  });

  // An id with no upload row is not an empty field: the value is still stored
  // and still validated on save, so the picker tells the editor it is missing.
  test("says 'Upload not found' for a stored id with no upload", () => {
    const html = render({ value: IMAGE.id });

    expect(html).toContain("Upload not found");
    expect(html).not.toContain("No image chosen.");
    expect(tag(html, "data-image-picker-value")).toContain(
      `value="${IMAGE.id}"`,
    );
  });

  // The field's own heading is the visible label; the picker keeps an
  // accessible name without drawing a second one.
  test("can hide its legend while keeping the field name", () => {
    const html = render({ labelHidden: true });

    expect(html).toContain(
      '<legend class="cms-field-label sr-only" id="cms-image-picker-socialImageId-label">Social image</legend>',
    );
  });

  // A block image field is one part of the generated form, so it renders no
  // named input: the value is read from the data attribute and serialised into
  // the hidden `content` field, and nothing stray joins the POST. It renders no
  // element ids either — a block is cloned from a `<template>`, so ids would be
  // repeated in every copy, and the legend names the fieldset regardless.
  test("renders no name and no ids when a block field passes none", () => {
    const html = render({ name: undefined });
    const input = tag(html, "data-image-picker-value");

    expect(input).not.toContain("name=");
    expect(input).toContain("data-image-id");
    expect(input).toMatch(/value(?:="")?\s/);
    expect(html).not.toContain("cms-image-picker-socialImageId");
    expect(html).not.toMatch(/\sid="/);
  });

  // A stored upload's width travels with the picker so the field can warn about
  // a too-narrow image before the editor touches it.
  test("carries the stored upload's width for the field's warning", () => {
    const html = render({ value: IMAGE.id, image: IMAGE });

    expect(tag(html, "data-image-picker-field")).toContain(
      `data-image-picker-width="${IMAGE.width}"`,
    );
  });

  test("shows the chosen image, its alt, size and a Remove button", () => {
    const html = render({ value: IMAGE.id, image: IMAGE });
    const thumb = tag(html, "data-image-picker-thumb");

    expect(thumb).toContain(`src="${IMAGE.thumbnailUrl}"`);
    expect(thumb).not.toContain("hidden");
    expect(html).toContain(`>${IMAGE.alt}</span>`);
    expect(html).toContain(">1600×900</span>");
    expect(tag(html, "data-image-picker-remove")).not.toContain("hidden");
  });

  // The approved mock-up correction: an upload with no usable rendition is a
  // placeholder tile with its alt text, never an `<img>` with no source that
  // the browser draws as a broken icon.
  test("renders a placeholder, not a broken image, when there is no thumbnail", () => {
    const html = render({
      value: IMAGE.id,
      image: { ...IMAGE, thumbnailUrl: null },
    });
    const thumb = tag(html, "data-image-picker-thumb");

    expect(thumb).toContain("hidden");
    expect(thumb).not.toContain("src=");
    expect(html).toMatch(
      /data-image-picker-thumb-placeholder[^>]*>A wooden pier at dusk</,
    );
  });

  test("points the fieldset at its help and error text", () => {
    const html = render({
      help: "Shown when shared.",
      errors: [{ path: "socialImageId", message: "Choose an image." }],
    });

    expect(html).toContain('id="cms-image-picker-socialImageId-help"');
    expect(html).toContain('class="cms-field-help"');
    expect(html).toContain("Shown when shared.");
    expect(html).toContain('id="cms-image-picker-socialImageId-error"');
    expect(html).toContain("Choose an image.");
    expect(tag(html, "data-image-picker-field")).toContain(
      'aria-describedby="cms-image-picker-socialImageId-help cms-image-picker-socialImageId-error"',
    );
    expect(tag(html, "data-image-picker-field")).toContain(
      'aria-invalid="true"',
    );
  });

  test("is not invalid and names no missing ids without help or errors", () => {
    const field = tag(render(), "data-image-picker-field");

    expect(field).not.toContain("aria-invalid");
    expect(field).not.toContain("aria-describedby");
  });

  // The dialog is in the document before any script runs, hidden, so opening it
  // moves no layout and the file input exists for the drop zone's label.
  test("renders the closed dialog with its accessible name and file input", () => {
    const html = render();
    const modal = tag(html, "data-image-picker-modal");

    expect(modal).toContain("hidden");
    expect(tag(html, "data-picker-dialog")).toContain('role="dialog"');
    expect(tag(html, "data-picker-dialog")).toContain('aria-modal="true"');
    expect(tag(html, "data-picker-dialog")).toContain(
      'aria-labelledby="cms-image-picker-socialImageId-title"',
    );
    expect(html).toContain(
      '<h2 id="cms-image-picker-socialImageId-title">Choose an image</h2>',
    );
    expect(tag(html, "data-image-picker-file")).toContain('type="file"');
    expect(tag(html, "data-image-picker-file")).toContain("multiple");
    expect(tag(html, "data-image-picker-file")).toContain(
      'accept="image/jpeg,image/png,image/webp"',
    );
  });

  test("starts the library and paging controls empty", () => {
    const html = render();

    expect(tag(html, "data-image-picker-grid")).toContain(
      'aria-label="Images"',
    );
    expect(tag(html, "data-image-picker-more")).toContain("hidden");
    expect(tag(html, "data-image-picker-status")).toContain('role="status"');
    expect(html).toContain('aria-label="Search images by alt text"');
  });
});
