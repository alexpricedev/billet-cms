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
