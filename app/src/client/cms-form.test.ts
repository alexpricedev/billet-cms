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
      <input type="radio" name="cta-type" value="url" data-link-type checked>
      <input type="radio" name="cta-type" value="page" data-link-type>
      <input type="radio" name="cta-type" value="email" data-link-type>
      <input type="radio" name="cta-type" value="phone" data-link-type>
      <div data-link-destination="url">
        <input type="url" data-link-url value="https://example.com">
      </div>
      <div data-link-destination="page">
        <select data-link-page>
          <option value="">Choose a page…</option>
          <option value="${MEDIA_ID}">About us (/about)</option>
        </select>
      </div>
      <div data-link-destination="email">
        <input type="email" data-link-email value="">
      </div>
      <div data-link-destination="phone">
        <input type="tel" data-link-phone value="">
      </div>
      <input type="text" data-link-label value="Go">
      <input type="text" data-link-title value="">
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

/** The first matching control in the mounted form, asserted present. */
const input = <T extends HTMLElement = HTMLInputElement>(
  selector: string,
): T => {
  const found = form().querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector} in the form`);
  return found;
};

/** A link field's server markup: four type radios and one input per type. */
const linkMarkup = (checked: string): string => `
  <form data-cms-form>
    <div data-field data-field-kind="link" data-field-name="cta">
      ${["url", "page", "email", "phone"]
        .map(
          (kind) =>
            `<input type="radio" name="cta-type" value="${kind}" data-link-type${
              kind === checked ? " checked" : ""
            }>`,
        )
        .join("")}
      <div data-link-destination="url">
        <input type="url" data-link-url value="">
      </div>
      <div data-link-destination="page">
        <select data-link-page>
          <option value="">Choose a page…</option>
          <option value="${MEDIA_ID}">About us (/about)</option>
        </select>
      </div>
      <div data-link-destination="email">
        <input type="email" data-link-email value="">
      </div>
      <div data-link-destination="phone">
        <input type="tel" data-link-phone value="">
      </div>
      <input type="text" data-link-label value="">
      <input type="text" data-link-title value="">
      <input type="checkbox" data-link-newtab>
    </div>
  </form>
`;

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
          <input type="radio" name="cta-type" value="url" data-link-type>
          <input type="radio" name="cta-type" value="page" data-link-type checked>
          <input type="radio" name="cta-type" value="email" data-link-type>
          <input type="radio" name="cta-type" value="phone" data-link-type>
          <div data-link-destination="url">
            <input type="url" data-link-url value="">
          </div>
          <div data-link-destination="page">
            <select data-link-page>
              <option value="">Choose a page…</option>
            </select>
          </div>
          <div data-link-destination="email">
            <input type="email" data-link-email value="">
          </div>
          <div data-link-destination="phone">
            <input type="tel" data-link-phone value="">
          </div>
          <input type="text" data-link-label value="Go">
          <input type="text" data-link-title value="">
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

  // Email and Phone have no stored type of their own: both save as url links
  // whose scheme is what the editor recognises them by on reload.
  test("reads an Email destination as a mailto: url", () => {
    mount(linkMarkup("email"));
    input("[data-link-email]").value = "hello@example.com";
    input("[data-link-label]").value = "Email us";

    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "mailto:hello@example.com",
      label: "Email us",
    });
  });

  // The placeholder is written with spaces. The allowlist accepts that form too
  // (MCP and imports send it), and the editor still saves the canonical compact
  // one so both routes end up with the same stored value.
  test("reads a Phone destination as a tel: url without whitespace", () => {
    mount(linkMarkup("phone"));
    input("[data-link-phone]").value = "+44 20 7946 0000";

    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "tel:+442079460000",
    });
  });

  // The New tab row is hidden for Email and Phone, so a tick left over from URL
  // must not be written onto a link that can't show it.
  test("leaves new tab out of an Email or Phone link", () => {
    mount(linkMarkup("email"));
    input("[data-link-email]").value = "hello@example.com";
    const newTab = form().querySelector<HTMLInputElement>("[data-link-newtab]");
    if (newTab) newTab.checked = true;

    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "mailto:hello@example.com",
    });
  });

  // Hover text alone is enough to keep page mode, so a failed save doesn't
  // throw away what the editor typed.
  test("keeps a page-mode link that has only hover text", () => {
    mount(linkMarkup("page"));
    input("[data-link-title]").value = "Read more";

    expect(buildContent(form()).cta).toEqual({
      type: "page",
      title: "Read more",
    });
  });

  test("saves hover text as the link's title, and leaves a blank one out", () => {
    mount(linkMarkup("url"));
    input("[data-link-url]").value = "https://example.com";
    input("[data-link-title]").value = "Read more";

    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "https://example.com",
      title: "Read more",
    });

    input("[data-link-title]").value = "";
    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "https://example.com",
    });
  });

  // A link always renders its own Button text now, but the serialiser still
  // reads the control rather than assuming it: a form from an older CMS has no
  // `[data-link-label]`, and the stored value must keep no invented label.
  test("writes no label for a link with no button-text control", () => {
    mount(linkMarkup("url"));
    input("[data-link-url]").value = "https://example.com";
    form().querySelector("[data-link-label]")?.remove();

    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "https://example.com",
    });
  });

  // Each type keeps its own destination input, and only the checked one is
  // read. Switching the type must not wipe a value: a mis-click on the radio
  // used to lose a typed URL, and switching back left it empty.
  test("keeps every destination when the link type changes", () => {
    mount(linkMarkup("url"));
    input("[data-link-url]").value = "https://example.com";
    input("[data-link-page]").value = MEDIA_ID;
    input("[data-link-email]").value = "hello@example.com";
    input("[data-link-phone]").value = "+44 20 7946 0000";

    const email = form().querySelector<HTMLInputElement>(
      '[data-link-type][value="email"]',
    );
    if (!email) throw new Error("no email radio");
    email.checked = true;
    email.dispatchEvent(new Event("change", { bubbles: true }));

    // Nothing was cleared, and the stored value is the selected type's own.
    expect(input("[data-link-url]").value).toBe("https://example.com");
    expect(input("[data-link-page]").value).toBe(MEDIA_ID);
    expect(input("[data-link-phone]").value).toBe("+44 20 7946 0000");
    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "mailto:hello@example.com",
    });

    // Switching back reads the URL that was there all along.
    const url = form().querySelector<HTMLInputElement>(
      '[data-link-type][value="url"]',
    );
    if (!url) throw new Error("no url radio");
    url.checked = true;
    url.dispatchEvent(new Event("change", { bubbles: true }));
    expect(buildContent(form()).cta).toEqual({
      type: "url",
      url: "https://example.com",
    });
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

  // The template's radios all carry one name. Copies must not keep it, or the
  // browser treats every row's switch as the same four-way group.
  test("gives a cloned link row a radio group of its own", () => {
    const radios = (name: string): string =>
      ["url", "page", "email", "phone"]
        .map(
          (kind, index) =>
            `<input type="radio" name="${name}" value="${kind}" data-link-type${
              index === 0 ? " checked" : ""
            }>`,
        )
        .join("");
    mount(`
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <div data-field data-field-kind="list" data-field-name="links" data-list>
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="link" data-field-name="link">
                ${radios("links-row-0")}
              </div>
            </div>
          </div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="link" data-field-name="link">
                ${radios("links-template")}
              </div>
            </div>
          </template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);

    const list = form().querySelector(
      '[data-field-name="links"]',
    ) as HTMLElement;
    const add = list.querySelector(
      ":scope > [data-list-add]",
    ) as HTMLButtonElement;
    add.click();
    add.click();

    const rows = Array.from(
      list.querySelectorAll(":scope > [data-list-items] > [data-list-item]"),
    );
    const names = rows.map(
      (row) =>
        new Set(
          Array.from(
            row.querySelectorAll<HTMLInputElement>("[data-link-type]"),
            (radio) => radio.name,
          ),
        ),
    );
    // Four options per row share one name; no two rows share it.
    for (const name of names) expect(name.size).toBe(1);
    expect(new Set(names.map((name) => [...name][0])).size).toBe(rows.length);
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

  test("picking a narrow image warns beside the field; a wide one clears it", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="image" data-field-name="photo" data-image-min-width="1600">
          <select data-image-picker>
            <option value="">Choose an image…</option>
            <option value="small" data-media-width="800">Small (800×400)</option>
            <option value="big" data-media-width="2000">Big (2000×1000)</option>
          </select>
          <input type="text" data-image-id value="">
          <input type="text" data-image-alt value="">
          <p class="cms-field-warning" data-image-warning hidden></p>
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    const warning = document.querySelector<HTMLElement>("[data-image-warning]");
    if (!picker || !warning) throw new Error("missing picker or warning");

    picker.value = "small";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("800px");
    expect(warning.textContent).toContain("1600px");

    picker.value = "big";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(warning.hidden).toBe(true);
    expect(warning.textContent).toBe("");
  });

  test("a field with no minimum width never warns, whatever the picker's width", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="image" data-field-name="photo">
          <select data-image-picker>
            <option value="">Choose an image…</option>
            <option value="small" data-media-width="100">Small (100×100)</option>
          </select>
          <input type="text" data-image-id value="">
          <p class="cms-field-warning" data-image-warning hidden></p>
        </div>
      </form>
    `);

    const picker = document.querySelector<HTMLSelectElement>(
      "[data-image-picker]",
    );
    const warning = document.querySelector<HTMLElement>("[data-image-warning]");
    if (!picker || !warning) throw new Error("missing picker or warning");

    picker.value = "small";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(warning.hidden).toBe(true);
  });

  test("typing a media id clears the picker's warning", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="image" data-field-name="photo" data-image-min-width="1600">
          <select data-image-picker>
            <option value="small" data-media-width="800" selected>Small (800×400)</option>
          </select>
          <input type="text" data-image-id value="small">
          <input type="text" data-image-alt value="">
          <p class="cms-field-warning" data-image-warning>already shown</p>
        </div>
      </form>
    `);

    const input = document.querySelector<HTMLInputElement>("[data-image-id]");
    const warning = document.querySelector<HTMLElement>("[data-image-warning]");
    if (!input || !warning) throw new Error("missing input or warning");
    expect(warning.hidden).toBe(false);

    input.value = "some-other-id";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(warning.hidden).toBe(true);
    expect(warning.textContent).toBe("");
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

// A text() field whose max is over 120 renders a textarea (field-control.tsx).
// It is still one plain line — Enter is refused and a pasted break becomes a
// space on save — and the script grows the box to its content. The CSS clips
// and drops the resize handle only on the class the script adds, so with
// JavaScript off the box keeps its scrollbar.
describe("long text fields", () => {
  const MARKUP = `
    <form data-cms-form>
      <input type="hidden" name="content" data-cms-content value="{}">
      <div data-field data-field-kind="text" data-field-name="quote">
        <textarea data-text-input rows="3">Two sentences</textarea>
        <p data-char-count data-char-max="10">13 / 10</p>
        <p data-char-over hidden>Use 10 characters or fewer.</p>
      </div>
    </form>
  `;

  const textarea = () =>
    input<HTMLTextAreaElement>("textarea[data-text-input]");

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("reads a textarea as the field's plain text value", () => {
    mount(MARKUP);
    expect(buildContent(form())).toEqual({ quote: "Two sentences" });
  });

  test("turns a pasted line break into a single space on save", () => {
    mount(MARKUP);
    textarea().value = "First line\nsecond line\r\nthird";
    expect(buildContent(form()).quote).toBe("First line second line third");

    // A run of breaks is one space, not one per break.
    textarea().value = "one\n\n\ntwo";
    expect(buildContent(form()).quote).toBe("one two");
  });

  test("counts and marks a textarea invalid past the limit", () => {
    mount(MARKUP);
    const count = document.querySelector("[data-char-count]") as HTMLElement;
    const over = document.querySelector("[data-char-over]") as HTMLElement;

    textarea().value = "abcdefghijk";
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
    expect(count.textContent).toBe("11 / 10");
    expect(over.hidden).toBe(false);
    expect(textarea().getAttribute("aria-invalid")).toBe("true");

    textarea().value = "abcde";
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
    expect(count.textContent).toBe("5 / 10");
    expect(over.hidden).toBe(true);
    expect(textarea().hasAttribute("aria-invalid")).toBe(false);
  });

  test("refuses Enter in a textarea and leaves other keys alone", () => {
    mount(MARKUP);
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea().dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);

    const letter = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
      cancelable: true,
    });
    textarea().dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);
  });

  test("grows on first paint, and only the script marks it grown", () => {
    document.body.innerHTML = MARKUP;
    // What the server sends: no class, so the stylesheet leaves the scrollbar.
    expect(textarea().classList.contains("cms-textarea-grown")).toBe(false);

    init();
    expect(textarea().classList.contains("cms-textarea-grown")).toBe(true);
    expect(textarea().style.height).not.toBe("");
  });

  test("grows again as text is typed", () => {
    document.body.innerHTML = MARKUP;
    init();
    const area = textarea();
    Object.defineProperty(area, "scrollHeight", {
      configurable: true,
      get: () => area.value.length * 2,
    });
    area.style.height = "";
    area.value = "abcdef";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(area.style.height).toBe("12px");
  });

  test("grows a textarea in a list row cloned after load", () => {
    mount(`
      <form data-cms-form>
        <div data-field data-field-kind="list" data-field-name="quotes" data-list>
          <div data-list-items>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <textarea data-text-input rows="3"></textarea>
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </div>
          <template data-list-template>
            <div data-list-item>
              <div data-field data-field-kind="text" data-field-name="item">
                <textarea data-text-input rows="3"></textarea>
              </div>
              <button type="button" data-list-remove>Remove</button>
            </div>
          </template>
          <button type="button" data-list-add>Add item</button>
        </div>
      </form>
    `);
    click(input("[data-list-add]"));
    const rows = form().querySelectorAll("[data-list-item]");
    expect(rows).toHaveLength(2);
    expect(
      rows[1]
        ?.querySelector("textarea")
        ?.classList.contains("cms-textarea-grown"),
    ).toBe(true);
  });

  test("grows a textarea in a block added after load", () => {
    mount(`
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <div data-cms-page-content>
          <div data-cms-blocks></div>
          <template data-cms-block-template data-block-type="prose">
            <fieldset data-cms-block data-block-type="prose">
              <div data-field data-field-kind="text" data-field-name="quote">
                <textarea data-text-input rows="3"></textarea>
              </div>
            </fieldset>
          </template>
          <div><button type="button" data-block-add="prose">Add prose</button></div>
        </div>
      </form>
    `);
    click(input("[data-block-add]"));
    expect(
      form()
        .querySelector("[data-cms-block] textarea")
        ?.classList.contains("cms-textarea-grown"),
    ).toBe(true);
  });
});

describe("url move line", () => {
  beforeEach(() => {
    mount(`
      <form data-cms-form>
        <input type="hidden" name="content" data-cms-content value="{}">
        <input id="url" data-url-live="/about" value="/about">
        <p data-url-move hidden>
          Publishing moves this page: <code>/about</code> will redirect to
          <code data-url-move-to>/about</code>.
        </p>
      </form>
    `);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("names the typed URL while it differs from the live one", () => {
    const input = document.getElementById("url") as HTMLInputElement;
    const line = document.querySelector("[data-url-move]") as HTMLElement;
    const to = document.querySelector("[data-url-move-to]") as HTMLElement;

    input.value = "/studio/";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(line.hidden).toBe(false);
    expect(to.textContent).toBe("/studio");

    input.value = " studio//team ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(to.textContent).toBe("/studio/team");

    input.value = " /about ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(line.hidden).toBe(true);

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(line.hidden).toBe(true);
  });
});
