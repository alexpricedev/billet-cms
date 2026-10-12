import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildContent, init, serializeRichText } from "./cms-form";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

const markup = `
  <form data-cms-form>
    <input type="hidden" name="content" data-cms-content value="{}">
    <div data-field data-field-kind="text" data-field-name="heading">
      <input type="text" data-text-input value="Hello">
    </div>
    <div data-field data-field-kind="richText" data-field-name="body" data-rich-text-field>
      <input type="hidden" data-rich-text-value value='{"type":"doc"}'>
      <div data-rich-text contenteditable="true">
        <p><strong>Hi</strong> there</p>
        <ul><li>one</li><li>two</li></ul>
      </div>
    </div>
    <div data-field data-field-kind="image" data-field-name="photo">
      <input type="text" data-image-id value="${MEDIA_ID}">
      <input type="text" data-image-alt value="Alt text">
    </div>
    <div data-field data-field-kind="link" data-field-name="cta">
      <select data-link-type>
        <option value="url" selected>External URL</option>
        <option value="page">CMS page</option>
      </select>
      <input type="text" data-link-url value="https://example.com">
      <input type="text" data-link-page value="">
      <input type="text" data-link-label value="Go">
      <input type="checkbox" data-link-newtab checked>
    </div>
    <div data-field data-field-kind="list" data-field-name="tags" data-list data-max="3">
      <div data-list-items>
        <div data-list-item>
          <div data-field data-field-kind="text" data-field-name="item">
            <input type="text" data-text-input value="one">
          </div>
          <button type="button" data-list-remove>Remove</button>
        </div>
        <div data-list-item>
          <div data-field data-field-kind="text" data-field-name="item">
            <input type="text" data-text-input value="">
          </div>
          <button type="button" data-list-remove>Remove</button>
        </div>
      </div>
      <template data-list-template>
        <div data-list-item>
          <div data-field data-field-kind="text" data-field-name="item">
            <input type="text" data-text-input value="">
          </div>
          <button type="button" data-list-remove>Remove</button>
        </div>
      </template>
      <button type="button" data-list-add>Add item</button>
    </div>
  </form>
`;

const form = () => document.querySelector("form") as HTMLFormElement;

describe("cms form editor", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    init();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("builds the content document from every control", () => {
    expect(buildContent(form())).toEqual({
      heading: "Hello",
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hi", marks: [{ type: "bold" }] },
              { type: "text", text: " there" },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "one" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "two" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      photo: { mediaId: MEDIA_ID, alt: "Alt text" },
      cta: {
        type: "url",
        url: "https://example.com",
        label: "Go",
        newTab: true,
      },
      // The empty row is dropped.
      tags: ["one"],
    });
  });

  test("leaves a cleared text field out of the document", () => {
    const input = form().querySelector<HTMLInputElement>("[data-text-input]");
    if (input) input.value = "";

    expect(buildContent(form()).heading).toBeUndefined();
  });

  test("writes the rebuilt document into the hidden field on submit", () => {
    const hidden = form().querySelector<HTMLInputElement>("[data-cms-content]");
    form().dispatchEvent(new Event("submit"));

    expect(hidden).not.toBeNull();
    expect(JSON.parse(hidden?.value ?? "{}").heading).toBe("Hello");
  });

  test("adds and removes list rows, respecting the maximum", () => {
    const list = form().querySelector("[data-list]") as HTMLElement;
    const add = list.querySelector("[data-list-add]") as HTMLButtonElement;
    const count = () => list.querySelectorAll("[data-list-item]").length;

    expect(count()).toBe(2);
    add.click();
    expect(count()).toBe(3);
    // At the maximum, another click does nothing.
    add.click();
    expect(count()).toBe(3);

    const remove = list.querySelector(
      "[data-list-remove]",
    ) as HTMLButtonElement;
    remove.click();
    expect(count()).toBe(2);
  });

  test("serializes an empty editor to an empty document", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "";

    expect(serializeRichText(editor)).toEqual({ type: "doc", content: [] });
  });
});
