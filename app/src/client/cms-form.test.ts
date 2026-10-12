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

/** Replace the page with markup of this test's choosing and wire it. */
const mount = (html: string) => {
  document.body.innerHTML = html;
  init();
};

describe("cms form editor", () => {
  beforeEach(() => {
    mount(markup);
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

  test("keeps focus in the form when a row is removed", () => {
    const list = form().querySelector("[data-list]") as HTMLElement;
    const remove = list.querySelector(
      "[data-list-remove]",
    ) as HTMLButtonElement;
    remove.focus();
    remove.click();

    // Removing the row must not drop focus to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      list.querySelector(":scope > [data-list-add]"),
    );
  });

  test("serializes an empty editor to an empty document", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "";

    expect(serializeRichText(editor)).toEqual({ type: "doc", content: [] });
  });
});

describe("rich text serialization", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const serialize = (html: string) => {
    const editor = document.createElement("div");
    editor.innerHTML = html;
    return serializeRichText(editor);
  };

  // The whole document survives a render-then-serialize round trip: the shapes
  // the server writes and the editor reads back have to be the same.
  test("round-trips the allowed nodes, marks and lists", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: " " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
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
                  content: [
                    { type: "text", text: "one", marks: [{ type: "bold" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const html = `
      <h2>Title</h2>
      <p><strong>Hi</strong> and <em>italic</em> <a href="https://example.com">link</a></p>
      <ul><li><p><strong>one</strong></p></li></ul>
    `;

    expect(serialize(html)).toEqual(document);
  });

  // Bare text at the block level used to re-walk the whole editor, duplicating
  // every field behind it.
  test("wraps bare root text once, without duplicating the rest", () => {
    expect(serialize("hello<p>there</p>")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "there" }] },
      ],
    });
  });

  // An inline element that starts a run used to lose the mark it carried.
  test("keeps the mark of an inline element that starts a list item", () => {
    expect(serialize("<ul><li><strong>Hi</strong> there</li></ul>")).toEqual({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Hi", marks: [{ type: "bold" }] },
                    { type: "text", text: " there" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("keeps a heading inside a list item a heading", () => {
    expect(serialize("<ul><li><h3>Section</h3></li></ul>")).toEqual({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "heading",
                  attrs: { level: 3 },
                  content: [{ type: "text", text: "Section" }],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

const nestedListMarkup = `
  <form data-cms-form>
    <input type="hidden" name="content" data-cms-content value="{}">
    <div data-field data-field-kind="list" data-field-name="groups" data-list data-max="3">
      <div data-list-items>
        <div data-list-item>
          <div data-field data-field-kind="list" data-field-name="item" data-list data-max="2">
            <div data-list-items>
              <div data-list-item>
                <div data-field data-field-kind="text" data-field-name="item">
                  <input type="text" data-text-input value="a">
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
          <button type="button" data-list-remove>Remove</button>
        </div>
      </div>
      <template data-list-template>
        <div data-list-item>
          <div data-field data-field-kind="list" data-field-name="item" data-list data-max="2">
            <div data-list-items></div>
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
          <button type="button" data-list-remove>Remove</button>
        </div>
      </template>
      <button type="button" data-list-add>Add item</button>
    </div>
  </form>
`;

describe("nested lists", () => {
  beforeEach(() => {
    mount(nestedListMarkup);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // A plain descendant selector matches the inner list's rows as the outer
  // list's too, so one list swallows the other's.
  test("reads each list's own rows, not a nested list's", () => {
    expect(buildContent(form())).toEqual({ groups: [["a"]] });
  });

  test("adds a row to the list whose Add button was clicked", () => {
    const outer = form().querySelector(
      '[data-field-name="groups"]',
    ) as HTMLElement;
    const outerAdd = outer.querySelector(
      ":scope > [data-list-add]",
    ) as HTMLButtonElement;

    outerAdd.click();
    expect(
      outer.querySelectorAll(":scope > [data-list-items] > [data-list-item]")
        .length,
    ).toBe(2);

    // A nested list cloned in the new row has no per-list listener of its own;
    // the form's delegated one still adds a row inside it.
    const newRow = outer.querySelectorAll(
      ":scope > [data-list-items] > [data-list-item]",
    )[1] as HTMLElement;
    const innerAdd = newRow.querySelector("[data-list-add]") as HTMLElement;
    innerAdd.click();

    const innerList = newRow.querySelector("[data-list]") as HTMLElement;
    expect(
      innerList.querySelectorAll(
        ":scope > [data-list-items] > [data-list-item]",
      ).length,
    ).toBe(1);
  });
});

describe("empty list rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The server renders one empty row for a list. A rich-text or nested-list row
  // reads back as a truthy empty document/array, which would become an entry.
  test("drops an untouched rich-text row instead of gaining a phantom item", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="notes" data-list>
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="richText" data-field-name="item">
                <div data-rich-text contenteditable="true"><p></p></div>
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
            <div data-list-item>
              <div data-field data-field-kind="richText" data-field-name="item">
                <div data-rich-text contenteditable="true"><p>kept</p></div>
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="richText" data-field-name="item">
                <div data-rich-text contenteditable="true"><p></p></div>
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    expect(buildContent(form()).notes).toEqual([
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "kept" }] },
        ],
      },
    ]);
  });

  test("drops an untouched nested-list row", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="groups" data-list>
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="list" data-field-name="item" data-list>
                <div data-list-items></div>
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
              <button type="button" data-list-remove>Remove</button>
            </div>
          </div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="list" data-field-name="item" data-list>
                <div data-list-items></div>
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
              <button type="button" data-list-remove>Remove</button>
            </div>
          </template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    expect(buildContent(form()).groups).toEqual([]);
  });
});
