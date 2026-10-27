import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildContent,
  buildPageContent,
  init,
  serializeRichText,
} from "./cms-form";

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
      <select data-link-page>
        <option value="">Choose a page…</option>
        <option value="${MEDIA_ID}">About us (/about)</option>
      </select>
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

  // A page-mode link with no page chosen yet used to serialize to nothing, so a
  // failed save re-rendered it as an empty URL link and lost the label.
  test("keeps a page-mode link's mode and label with no page chosen", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="link" data-field-name="cta">
          <select data-link-type>
            <option value="url">External URL</option>
            <option value="page" selected>CMS page</option>
          </select>
          <input type="text" data-link-url value="">
          <select data-link-page>
            <option value="">Choose a page…</option>
          </select>
          <input type="text" data-link-label value="Go">
          <input type="checkbox" data-link-newtab>
        </div>
      </form>
    `);

    expect(buildContent(form()).cta).toEqual({ type: "page", label: "Go" });

    // A page-mode link that carries nothing at all is still dropped.
    const label = form().querySelector<HTMLInputElement>("[data-link-label]");
    if (label) label.value = "";
    expect(buildContent(form()).cta).toBeUndefined();
  });

  test("writes the rebuilt document into the hidden field on submit", () => {
    const hidden = form().querySelector<HTMLInputElement>("[data-cms-content]");
    form().dispatchEvent(new Event("submit"));

    expect(hidden).not.toBeNull();
    expect(JSON.parse(hidden?.value ?? "{}").heading).toBe("Hello");
  });

  test("adds and removes list rows, and marks Add disabled at the maximum", () => {
    const list = form().querySelector("[data-list]") as HTMLElement;
    const add = list.querySelector("[data-list-add]") as HTMLButtonElement;
    const count = () => list.querySelectorAll("[data-list-item]").length;

    expect(count()).toBe(2);
    expect(add.getAttribute("aria-disabled")).toBeNull();
    add.click();
    expect(count()).toBe(3);
    // At the maximum the Add button is marked disabled, so the editor is told
    // why another row won't appear rather than clicking into nothing.
    expect(add.getAttribute("aria-disabled")).toBe("true");
    add.click();
    expect(count()).toBe(3);

    const remove = list.querySelector(
      "[data-list-remove]",
    ) as HTMLButtonElement;
    remove.click();
    expect(count()).toBe(2);
    // Freeing a slot re-enables Add.
    expect(add.getAttribute("aria-disabled")).toBeNull();
  });

  // The Add button carries the state, not a `disabled` attribute, so a
  // programmatic click still reaches the handler; the row-count guard is what
  // refuses it.
  test("ignores a click on an Add button that is at the maximum", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="tags" data-list data-max="1">
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <input type="text" data-text-input value="only">
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
          <button type="button" data-list-add aria-disabled="true">Add item</button>
        </div>
      </form>
    `);

    const list = form().querySelector("[data-list]") as HTMLElement;
    const add = list.querySelector("[data-list-add]") as HTMLButtonElement;
    add.click();
    expect(list.querySelectorAll("[data-list-item]")).toHaveLength(1);
  });

  // Adding a row should leave the caret in it, not back on the Add button.
  test("focuses the new row's first control after adding", () => {
    const list = form().querySelector("[data-list]") as HTMLElement;
    const add = list.querySelector("[data-list-add]") as HTMLButtonElement;
    add.click();

    const added = list.querySelectorAll("[data-list-item]")[2];
    expect(document.activeElement).toBe(added?.querySelector("input"));
  });

  test("ships Add disabled when the server rendered a full list", () => {
    // The server marks the button aria-disabled; init must leave it that way
    // and re-enable it once a row is removed.
    mount(`
      <form data-cms-form>
        <input type="hidden" data-cms-content />
        <div data-field data-field-kind="list" data-field-name="tags" data-list data-max="1">
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <input type="text" data-text-input value="only" />
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <input type="text" data-text-input value="" />
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </template>
          <button type="button" data-list-add aria-disabled="true">Add item</button>
        </div>
      </form>
    `);

    const list = form().querySelector("[data-list]") as HTMLElement;
    const add = list.querySelector("[data-list-add]") as HTMLButtonElement;
    expect(add.getAttribute("aria-disabled")).toBe("true");

    (list.querySelector("[data-list-remove]") as HTMLButtonElement).click();
    expect(add.getAttribute("aria-disabled")).toBeNull();
  });

  // Removing a row used to drop focus onto the list's Add button always —
  // fine for the last row, wrong for the middle of a list, where it skips the
  // rows below.
  test("moves focus to the next row's control when a row is removed", () => {
    const list = form().querySelector("[data-list]") as HTMLElement;
    const remove = list.querySelector(
      "[data-list-remove]",
    ) as HTMLButtonElement;
    remove.focus();
    remove.click();

    expect(document.activeElement).not.toBe(document.body);
    const rows = list.querySelectorAll(
      ":scope > [data-list-items] > [data-list-item]",
    );
    expect(document.activeElement).toBe(rows[0].querySelector("input"));
  });

  test("falls back to the list's Add button when the last row is removed", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="tags" data-list>
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <input type="text" data-text-input value="only">
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </div>
          <template data-list-template></template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    const list = form().querySelector("[data-list]") as HTMLElement;
    (list.querySelector("[data-list-remove]") as HTMLButtonElement).click();

    expect(document.activeElement).toBe(
      list.querySelector(":scope > [data-list-add]"),
    );
  });

  test("falls back to the previous row's control when the last of several is removed", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="tags" data-list>
          <div data-list-items>
            ${["one", "two", "three"]
              .map(
                (value) => `
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <input type="text" data-text-input value="${value}">
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>`,
              )
              .join("")}
          </div>
          <template data-list-template></template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    const rows = () => form().querySelectorAll(":scope [data-list-item]");
    (
      rows()[2].querySelector("[data-list-remove]") as HTMLButtonElement
    ).click();

    // The last row has no next; focus lands back on the row above it, not Add.
    expect(document.activeElement).toBe(rows()[1].querySelector("input"));
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

const nestedMaxMarkup = `
  <form data-cms-form>
    <input type="hidden" name="content" data-cms-content value="{}">
    <div data-field data-field-kind="list" data-field-name="groups" data-list>
      <div data-list-items></div>
      <template data-list-template>
        <div data-list-item>
          <div data-field data-field-kind="list" data-field-name="item" data-list data-max="1">
            <div data-list-items>
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
          <button type="button" data-list-remove>Remove</button>
        </div>
      </template>
      <button type="button" data-list-add>Add item</button>
    </div>
  </form>
`;

// A list inside a cloned row was rendered against the template's empty value,
// so its own Add state is stale: a nested list with max one arrives holding the
// template's row and an enabled Add. The clone is synced as it is added.
describe("cloned list state", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("syncs the Add state of a list inside a newly cloned row", () => {
    mount(nestedMaxMarkup);
    const outer = form().querySelector(
      '[data-field-name="groups"]',
    ) as HTMLElement;
    (
      outer.querySelector(":scope > [data-list-add]") as HTMLButtonElement
    ).click();

    const row = outer.querySelector(
      ":scope > [data-list-items] > [data-list-item]",
    ) as HTMLElement;
    const innerAdd = row.querySelector(
      "[data-list] > [data-list-add]",
    ) as HTMLButtonElement;

    expect(innerAdd.getAttribute("aria-disabled")).toBe("true");
  });

  test("syncs the Add state of a list inside a newly cloned block", () => {
    mount(`
      <form data-cms-form>
        <input type="hidden" data-cms-content value="{}">
        <div data-cms-page-content>
          <div data-cms-blocks></div>
          <template data-cms-block-template data-block-type="prose">
            <fieldset data-cms-block data-block-type="prose">
              <div data-field data-field-kind="list" data-field-name="tags" data-list data-max="1">
                <div data-list-items>
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
            </fieldset>
          </template>
          <div class="cms-block-add">
            <button type="button" data-block-add="prose">Add prose</button>
          </div>
        </div>
      </form>
    `);

    click(document.querySelector("[data-block-add]") as Element);
    const list = document.querySelector("[data-cms-block] [data-list]");
    const add = list?.querySelector(":scope > [data-list-add]");
    expect(add?.getAttribute("aria-disabled")).toBe("true");
  });
});

const richListMarkup = `
  <form data-cms-form>
    <input type="hidden" name="content" data-cms-content value="{}">
    <div data-field data-field-kind="list" data-field-name="notes" data-list data-max="3">
      <div data-list-items>
        <div data-list-item>
          <div data-field data-field-kind="richText" data-field-name="item" data-rich-text-field>
            <div class="cms-rte-toolbar">
              <button type="button" data-rich-command="bold">B</button>
            </div>
            <div data-rich-text contenteditable="true" tabindex="0"><p></p></div>
          </div>
          <button type="button" data-list-remove>Remove</button>
        </div>
      </div>
      <template data-list-template>
        <div data-list-item>
          <div data-field data-field-kind="richText" data-field-name="item" data-rich-text-field>
            <div class="cms-rte-toolbar">
              <button type="button" data-rich-command="bold">B</button>
            </div>
            <div data-rich-text contenteditable="true" tabindex="0"><p></p></div>
          </div>
          <button type="button" data-list-remove>Remove</button>
        </div>
      </template>
      <button type="button" data-list-add>Add item</button>
    </div>
  </form>
`;

describe("rich text in added rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // happy-dom has no document.execCommand; remove the stub a test installs.
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  // A per-button listener only reached the toolbar in the row present at load;
  // the toolbar in a cloned row had none, so its buttons did nothing.
  test("runs a toolbar command from a row added after load", () => {
    const calls: string[] = [];
    (
      document as unknown as { execCommand: (command: string) => void }
    ).execCommand = (command) => {
      calls.push(command);
    };

    mount(richListMarkup);
    const add = form().querySelector("[data-list-add]") as HTMLButtonElement;
    add.click();

    const rows = form().querySelectorAll("[data-list-item]");
    const button = rows[1].querySelector(
      "[data-rich-command='bold']",
    ) as HTMLButtonElement;
    button.click();

    expect(calls).toEqual(["bold"]);
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

const PAGE_MARKUP = `
  <form data-cms-form>
    <input type="hidden" name="content" data-cms-content value="{}">
    <input type="hidden" name="removed_blocks" data-cms-removed value="">
    <input type="hidden" name="dropped_blocks" data-cms-dropped value="">
    <div data-cms-page-content>
      <div data-cms-blocks>
        <fieldset data-cms-block data-block-type="hero">
          <div data-field data-field-kind="text" data-field-name="heading">
            <input type="text" data-text-input value="Hello">
          </div>
        </fieldset>
        <fieldset data-cms-block data-block-unavailable data-block-type="gone" data-block-index="1">
          <p>No longer editable</p>
          <button type="button" data-block-remove>Remove</button>
        </fieldset>
      </div>
      <template data-cms-block-template data-block-type="prose">
        <fieldset data-cms-block data-block-type="prose">
          <div data-field data-field-kind="text" data-field-name="heading">
            <input type="text" data-text-input value="">
          </div>
        </fieldset>
      </template>
      <div class="cms-block-add">
        <button type="button" data-block-add="prose">Add prose</button>
      </div>
    </div>
  </form>
`;

const click = (target: Element) => {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

describe("page block editor", () => {
  beforeEach(() => {
    mount(PAGE_MARKUP);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("reads the blocks in order, skipping an unavailable one", () => {
    expect(buildPageContent(form())).toEqual({
      blocks: [{ type: "hero", heading: "Hello" }],
    });
  });

  const addEmpty = (type: string) => {
    const add = document.querySelector(`[data-block-add="${type}"]`);
    if (!add) throw new Error("no add button");
    click(add);
  };
  const droppedField = () =>
    document.querySelector<HTMLInputElement>("[data-cms-dropped]");

  test("reports no dropped blocks when every block has content", () => {
    form().dispatchEvent(new Event("submit"));
    expect(droppedField()?.value).toBe("");
  });

  test("reports one block left empty, and still skips it", () => {
    addEmpty("prose");
    form().dispatchEvent(new Event("submit"));
    expect(droppedField()?.value).toBe("prose");
    expect(buildPageContent(form())).toEqual({
      blocks: [{ type: "hero", heading: "Hello" }],
    });
  });

  test("reports several empty blocks, in order", () => {
    addEmpty("prose");
    addEmpty("prose");
    form().dispatchEvent(new Event("submit"));
    expect(droppedField()?.value).toBe("prose,prose");
  });

  test("adds a block from the type's template", () => {
    const add = document.querySelector("[data-block-add]");
    if (!add) throw new Error("no add button");
    click(add);

    const blocks = document.querySelectorAll("[data-cms-block]");
    // The stored hero, the unavailable block, and the added prose.
    expect(blocks).toHaveLength(3);

    // Filling the new block makes it part of the saved content.
    const added = blocks[2];
    const input = added?.querySelector("input");
    if (input) input.value = "Body";
    expect(buildPageContent(form())).toEqual({
      blocks: [
        { type: "hero", heading: "Hello" },
        { type: "prose", heading: "Body" },
      ],
    });
  });

  describe("Add at the page type's maximum", () => {
    const LIMITED = PAGE_MARKUP.replace(
      '<button type="button" data-block-add="prose">Add prose</button>',
      `<button type="button" data-block-add="prose" data-block-max="2" aria-describedby="limit-prose">Add prose</button>
        <span id="limit-prose" hidden>Only 2 prose blocks per page</span>`,
    );
    const add = () => document.querySelector("[data-block-add]") as Element;
    const hint = () => document.getElementById("limit-prose") as HTMLElement;
    const proseCount = () =>
      document.querySelectorAll('[data-cms-block][data-block-type="prose"]')
        .length;

    beforeEach(() => {
      document.body.innerHTML = "";
      mount(LIMITED);
    });

    test("greys out after adding to the max, and a click then adds nothing", () => {
      expect(add().hasAttribute("aria-disabled")).toBe(false);
      click(add());
      expect(add().hasAttribute("aria-disabled")).toBe(false);
      click(add());
      expect(add().getAttribute("aria-disabled")).toBe("true");
      expect(hint().hasAttribute("hidden")).toBe(false);
      click(add());
      expect(proseCount()).toBe(2);
    });

    test("comes back when a block is removed", () => {
      click(add());
      click(add());
      const remove = document.createElement("button");
      remove.setAttribute("data-block-remove", "");
      document
        .querySelector('[data-cms-block][data-block-type="prose"]')
        ?.append(remove);
      click(remove);
      expect(add().hasAttribute("aria-disabled")).toBe(false);
      expect(hint().hasAttribute("hidden")).toBe(true);
      expect(proseCount()).toBe(1);
    });

    test("a flagged block marked removed stops counting", () => {
      document.body.innerHTML = "";
      mount(
        LIMITED.replace(
          'data-block-type="gone"',
          'data-block-type="prose"',
        ).replace('data-block-max="2"', 'data-block-max="1"'),
      );
      expect(add().getAttribute("aria-disabled")).toBe("true");
      const flagged = document.querySelector("[data-block-unavailable]");
      click(flagged?.querySelector("[data-block-remove]") as Element);
      expect(add().hasAttribute("aria-disabled")).toBe(false);
    });
  });

  // Part 6: the line stays visible after a block is added, including one added
  // in this tab and not yet saved — so the client toggles it from the list.
  describe("empty-state line", () => {
    const MARKUP = `
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <div data-cms-page-content>
          <div data-cms-blocks></div>
          <p class="cms-blocks-empty" data-cms-blocks-empty>This page has no blocks yet. Add one below.</p>
          <template data-cms-block-template data-block-type="prose">
            <fieldset data-cms-block data-block-type="prose">
              <div data-field data-field-kind="text" data-field-name="heading">
                <input type="text" data-text-input value="">
              </div>
              <button type="button" data-block-remove>Remove</button>
            </fieldset>
          </template>
          <div class="cms-block-add">
            <button type="button" data-block-add="prose">Add prose</button>
          </div>
        </div>
      </form>
    `;
    const empty = () =>
      document.querySelector("[data-cms-blocks-empty]") as HTMLElement;

    beforeEach(() => {
      document.body.innerHTML = "";
      mount(MARKUP);
    });

    test("shows with no blocks", () => {
      expect(empty().hidden).toBe(false);
    });

    test("hides when a block is added and comes back when it is removed", () => {
      click(document.querySelector("[data-block-add]") as Element);
      expect(empty().hidden).toBe(true);

      click(
        document.querySelector(
          "[data-cms-block] [data-block-remove]",
        ) as Element,
      );
      expect(empty().hidden).toBe(false);
    });

    test("stays hidden while a flagged block is only marked removed", () => {
      // A flagged block is still a block until the save carries the removal
      // through, and it is not detached — so the line must not reappear until
      // the marker is set.
      document.body.innerHTML = "";
      mount(
        MARKUP.replace(
          "<div data-cms-blocks></div>",
          `<div data-cms-blocks>
            <fieldset data-cms-block data-block-unavailable data-block-index="0">
              <button type="button" data-block-remove>Remove</button>
            </fieldset>
          </div>`,
        ),
      );
      expect(empty().hidden).toBe(true);

      click(document.querySelector("[data-block-remove]") as Element);
      expect(empty().hidden).toBe(false);
    });
  });

  test("removes a block", () => {
    const remove = document.createElement("button");
    remove.setAttribute("data-block-remove", "");
    const hero = document.querySelector(
      '[data-cms-block][data-block-type="hero"]',
    );
    hero?.append(remove);
    click(remove);

    expect(
      document.querySelectorAll('[data-cms-block][data-block-type="hero"]'),
    ).toHaveLength(0);
    expect(buildPageContent(form())).toEqual({ blocks: [] });
  });

  // A flagged block has no field controls, so the client can't serialize its
  // removal into `content`: it records the block's base index in the form's
  // `removed_blocks` field instead (review round 2).
  test("marks a flagged block removed with its base-revision index", () => {
    const flagged = document.querySelector(
      '[data-cms-block][data-block-type="gone"]',
    );
    const remove = flagged?.querySelector("[data-block-remove]");
    if (!remove) throw new Error("no remove button");
    click(remove);

    const marker = form().querySelector<HTMLInputElement>("[data-cms-removed]");
    expect(marker?.value).toBe("1");
    // Hidden, not detached: the marker rides with the block until submit, and
    // the block is still skipped from the rebuilt content.
    expect(flagged?.hasAttribute("data-block-removed")).toBe(true);
    expect(flagged?.hasAttribute("hidden")).toBe(true);
    expect(buildPageContent(form())).toEqual({
      blocks: [{ type: "hero", heading: "Hello" }],
    });
  });

  test("accumulates several removed flagged blocks without repeating one", () => {
    const flagged = document.querySelector(
      '[data-cms-block][data-block-type="gone"]',
    );
    const remove = flagged?.querySelector("[data-block-remove]");
    if (!remove) throw new Error("no remove button");
    click(remove);
    click(remove);

    const marker = form().querySelector<HTMLInputElement>("[data-cms-removed]");
    expect(marker?.value).toBe("1");
  });

  test("moves a block down past the next one", () => {
    const down = document.createElement("button");
    down.setAttribute("data-block-down", "");
    const hero = document.querySelector(
      '[data-cms-block][data-block-type="hero"]',
    );
    hero?.append(down);
    click(down);

    const blocks = Array.from(
      document.querySelectorAll("[data-cms-block]"),
    ).map((block) => block.getAttribute("data-block-type"));
    expect(blocks[0]).not.toBe("hero");
  });
});

describe("media picker", () => {
  test("choosing an upload writes its id into the media-id input", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="image" data-field-name="photo">
          <select data-image-picker>
            <option value="">Choose an image…</option>
            <option value="${MEDIA_ID}">A photo (800×400)</option>
          </select>
          <input type="text" data-image-id value="">
          <input type="text" data-image-alt value="">
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    if (!picker) throw new Error("no picker");
    picker.value = MEDIA_ID;
    picker.dispatchEvent(new Event("change", { bubbles: true }));

    expect(
      form().querySelector<HTMLInputElement>("[data-image-id]")?.value,
    ).toBe(MEDIA_ID);
    expect(buildContent(form()).photo).toEqual({ mediaId: MEDIA_ID });
  });

  test("fills a picker from the form's options template on first focus", () => {
    mount(`
      <form data-cms-form>
        <template data-media-options>
          <option value="${MEDIA_ID}">A photo (800×400)</option>
        </template>
        <div data-field data-field-kind="image" data-field-name="photo">
          <select data-image-picker>
            <option value="">Choose an image…</option>
          </select>
          <input type="text" data-image-id value="">
          <input type="text" data-image-alt value="">
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    if (!picker) throw new Error("no picker");
    expect(picker.options.length).toBe(1);

    picker.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(picker.options.length).toBe(2);
    expect(
      picker.querySelector(`option[value="${MEDIA_ID}"]`)?.textContent,
    ).toBe("A photo (800×400)");

    // Filling twice does not duplicate the options.
    picker.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(picker.options.length).toBe(2);
  });

  // The server renders a current image with only a fallback label; when the
  // template lists that same image, filling relabels the existing option from
  // it rather than skipping it and leaving the fallback (review round 1, item 2).
  test("relabels a current image that is also in the newest uploads", () => {
    mount(`
      <form data-cms-form>
        <template data-media-options>
          <option value="${MEDIA_ID}">A photo (800×400)</option>
        </template>
        <div data-field data-field-kind="image" data-field-name="photo">
          <select data-image-picker>
            <option value="">Choose an image…</option>
            <option value="${MEDIA_ID}" selected>Current image</option>
          </select>
          <input type="text" data-image-id value="${MEDIA_ID}">
          <input type="text" data-image-alt value="">
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    if (!picker) throw new Error("no picker");
    picker.dispatchEvent(new Event("focusin", { bubbles: true }));

    expect(picker.options.length).toBe(2);
    expect(
      picker.querySelector(`option[value="${MEDIA_ID}"]`)?.textContent,
    ).toBe("A photo (800×400)");
    expect(picker.value).toBe(MEDIA_ID);
  });

  // A current image with a per-use alt keeps the editor's label: that alt is
  // what the site renders for this use, so the library's own alt must not
  // quietly replace it when the picker is focused.
  test("keeps a per-use alt on the current image's option", () => {
    mount(`
      <form data-cms-form>
        <template data-media-options>
          <option value="${MEDIA_ID}">A photo (800×400)</option>
        </template>
        <div data-field data-field-kind="image" data-field-name="photo">
          <select data-image-picker>
            <option value="">Choose an image…</option>
            <option value="${MEDIA_ID}" selected data-media-keep-label>Stored alt</option>
          </select>
          <input type="text" data-image-id value="${MEDIA_ID}">
          <input type="text" data-image-alt value="Stored alt">
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    if (!picker) throw new Error("no picker");
    picker.dispatchEvent(new Event("focusin", { bubbles: true }));

    expect(picker.options.length).toBe(2);
    expect(
      picker.querySelector(`option[value="${MEDIA_ID}"]`)?.textContent,
    ).toBe("Stored alt");
    expect(picker.value).toBe(MEDIA_ID);
  });

  test("fills a picker in a list row added after the page loaded", () => {
    mount(`
      <form data-cms-form>
        <template data-media-options>
          <option value="${MEDIA_ID}">A photo (800×400)</option>
        </template>
        <div data-field data-field-kind="list" data-field-name="gallery" data-list>
          <div data-list-items></div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="image" data-field-name="item">
                <select data-image-picker>
                  <option value="">Choose an image…</option>
                </select>
                <input type="text" data-image-id value="">
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    const add = document.querySelector("[data-list-add]");
    if (!add) throw new Error("no add button");
    click(add);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    if (!picker) throw new Error("no picker");
    picker.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(picker.options.length).toBe(2);
    expect(picker.querySelector(`option[value="${MEDIA_ID}"]`)).not.toBeNull();
  });
});

describe("focal point picker", () => {
  const focalMarkup = `
    <form data-cms-form>
      <input type="hidden" data-focal-x value="0.5">
      <input type="hidden" data-focal-y value="0.5">
      <button type="button" data-focal-picker>
        <img data-focal-image alt="">
        <span data-focal-marker></span>
      </button>
      <img data-focal-preview alt="">
    </form>
  `;

  const picker = () => {
    const element = document.querySelector<HTMLElement>("[data-focal-picker]");
    if (!element) throw new Error("no focal picker");
    return element;
  };

  test("a click sets the focal point from where the pointer landed", () => {
    mount(focalMarkup);
    picker().getBoundingClientRect = (() =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 100,
        right: 300,
        bottom: 150,
      }) as DOMRect) as () => DOMRect;

    picker().dispatchEvent(
      new MouseEvent("click", {
        clientX: 150,
        clientY: 100,
        detail: 1,
        bubbles: true,
      }),
    );

    expect(
      form().querySelector<HTMLInputElement>("[data-focal-x]")?.value,
    ).toBe("0.25");
    expect(
      form().querySelector<HTMLInputElement>("[data-focal-y]")?.value,
    ).toBe("0.5");
    expect(
      picker().querySelector<HTMLElement>("[data-focal-marker]")?.style.left,
    ).toBe("25%");
    expect(
      form().querySelector<HTMLElement>("[data-focal-preview]")?.style
        .objectPosition,
    ).toBe("25% 50%");
  });

  // Enter or Space on the button fires a click with no pointer coordinates
  // (`detail === 0`, clientX/Y 0). Without the guard that would snap the focal
  // point to the top-left corner (review r1-5).
  test("ignores the keyboard click that carries no pointer coordinates", () => {
    mount(focalMarkup);

    picker().dispatchEvent(
      new MouseEvent("click", {
        clientX: 0,
        clientY: 0,
        detail: 0,
        bubbles: true,
      }),
    );

    expect(
      form().querySelector<HTMLInputElement>("[data-focal-x]")?.value,
    ).toBe("0.5");
    expect(
      form().querySelector<HTMLInputElement>("[data-focal-y]")?.value,
    ).toBe("0.5");
    expect(
      picker().querySelector<HTMLElement>("[data-focal-marker]")?.style.left,
    ).toBe("");
  });

  test("arrow keys nudge the focal point", () => {
    mount(focalMarkup);

    picker().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(
      form().querySelector<HTMLInputElement>("[data-focal-x]")?.value,
    ).toBe("0.51");
    expect(
      form().querySelector<HTMLElement>("[data-focal-preview]")?.style
        .objectPosition,
    ).toBe("51% 50%");
  });
});

describe("character count", () => {
  beforeEach(() => {
    mount(`
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <div data-field data-field-kind="text">
          <input type="text" data-text-input value="abc">
          <p data-char-count data-char-max="5">3 / 5</p>
          <p data-char-over hidden>Use 5 characters or fewer.</p>
        </div>
      </form>
    `);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("counts live and shows the error past the limit", () => {
    const input = document.querySelector(
      "[data-text-input]",
    ) as HTMLInputElement;
    const count = document.querySelector("[data-char-count]") as HTMLElement;
    const over = document.querySelector("[data-char-over]") as HTMLElement;

    input.value = "abcdefg";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(count.textContent).toBe("7 / 5");
    expect(over.hidden).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    input.value = "abcde";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(count.textContent).toBe("5 / 5");
    expect(over.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("url move line", () => {
  beforeEach(() => {
    mount(`
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <input id="url" data-url-live="/about" value="/about">
        <p data-url-move hidden>Saving moves this page</p>
      </form>
    `);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("shows while the URL differs from the stored one", () => {
    const input = document.getElementById("url") as HTMLInputElement;
    const line = document.querySelector("[data-url-move]") as HTMLElement;
    input.value = "/studio";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(line.hidden).toBe(false);
    input.value = " /about ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(line.hidden).toBe(true);
  });
});
