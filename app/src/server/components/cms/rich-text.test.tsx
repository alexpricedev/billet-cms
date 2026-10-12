import { describe, expect, test } from "bun:test";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import { renderToString } from "preact-render-to-string";
import { RichTextView } from "./rich-text";

const render = (document: RichTextDocument): string =>
  renderToString(<RichTextView document={document} />);

describe("RichTextView", () => {
  test("renders the allowed block nodes", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Body" }],
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
          ],
        },
      ],
    });

    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<p>Body</p>");
    expect(html).toContain("<ul><li><p>one</p></li></ul>");
  });

  test("renders inline marks, including a link", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    });

    expect(html).toContain("<strong>Hi</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  test("gives an empty document a paragraph to hold the caret", () => {
    expect(render({ type: "doc", content: [] })).toContain("<p></p>");
  });
});
