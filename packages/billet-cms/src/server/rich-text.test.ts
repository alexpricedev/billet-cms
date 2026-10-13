import { describe, expect, test } from "bun:test";
import type { RichTextContent, RichTextDocument } from "../fields/rich-text";
import { renderRichText } from "./rich-text";

const doc = (...content: RichTextContent[]): RichTextDocument => ({
  type: "doc",
  content,
});

describe("renderRichText", () => {
  test("renders the allowed block nodes", () => {
    const html = renderRichText(
      doc(
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Three" }],
                },
              ],
            },
          ],
        },
      ),
    );

    expect(html).toBe(
      "<p>Hello</p><h3>Title</h3><ul><li><p>One</p></li></ul>" +
        '<ol start="3"><li><p>Three</p></li></ol>',
    );
  });

  test("renders bold, italic and links, in mark order", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Buy now",
            marks: [
              { type: "bold" },
              { type: "italic" },
              { type: "link", attrs: { href: "https://example.com/a" } },
            ],
          },
        ],
      }),
    );

    expect(html).toBe(
      '<p><strong><em><a href="https://example.com/a">Buy now</a></em></strong></p>',
    );
  });

  test("adds a safe rel to a new-tab link", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Docs",
            marks: [
              {
                type: "link",
                attrs: { href: "/docs", target: "_blank" },
              },
            ],
          },
        ],
      }),
    );

    expect(html).toBe(
      '<p><a href="/docs" target="_blank" rel="noopener noreferrer">Docs</a></p>',
    );
  });

  test("escapes text", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [{ type: "text", text: `<script>alert("x")</script> & more` }],
      }),
    );

    expect(html).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>",
    );
    expect(html).not.toContain("<script");
  });

  test("escapes a link href and keeps the text", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "search & find",
            marks: [{ type: "link", attrs: { href: "/search?a=1&b=2" } }],
          },
        ],
      }),
    );

    expect(html).toBe(
      '<p><a href="/search?a=1&amp;b=2">search &amp; find</a></p>',
    );
  });

  // Defence in depth: the stored schema already refuses these, but the renderer
  // does not trust a row it didn't validate. The anchor is dropped, the text stays.
  test("drops a link whose href is outside the allowlist", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "click me",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      }),
    );

    expect(html).toBe("<p>click me</p>");
    expect(html).not.toContain("javascript:");
  });

  test("renders a hard break", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "hardBreak" },
          { type: "text", text: "b" },
        ],
      }),
    );

    expect(html).toBe("<p>a<br>b</p>");
  });

  // The node set is closed: a row with something else renders nothing rather
  // than falling through to markup the validator never allowed.
  test("ignores an unknown node", () => {
    const html = renderRichText(
      doc(
        {
          type: "paragraph",
          content: [{ type: "text", text: "kept" }],
        },
        {
          type: "iframe",
          attrs: { src: "https://evil.example" },
        } as unknown as RichTextContent,
      ),
    );

    expect(html).toBe("<p>kept</p>");
  });

  test("renders the empty string for an empty or unreadable document", () => {
    expect(renderRichText(doc())).toBe("");
    expect(renderRichText(null as unknown as RichTextDocument)).toBe("");
    expect(
      renderRichText({ type: "nope" } as unknown as RichTextDocument),
    ).toBe("");
  });

  // `start` lands inside an HTML attribute, so a hand-edited row must not be
  // able to close the quote and add one of its own. Only a real integer above
  // one is emitted; a string, a float and one itself fall back to `<ol>`.
  test("ignores an ordered list start that is not an integer above one", () => {
    const list = (start: unknown) =>
      renderRichText(
        doc({
          type: "orderedList",
          attrs: { start },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
          ],
        } as unknown as RichTextContent),
      );

    expect(list(5)).toBe('<ol start="5"><li><p>One</p></li></ol>');
    expect(list(1)).toBe("<ol><li><p>One</p></li></ol>");
    expect(list(2.5)).toBe("<ol><li><p>One</p></li></ol>");

    const injected = list('1" onmouseover="alert(1)');
    expect(injected).toBe("<ol><li><p>One</p></li></ol>");
    expect(injected).not.toContain("onmouseover");
  });

  // An unknown mark is not a link, even when it carries an `attrs.href`: only a
  // mark whose `type` is literally "link" becomes an anchor.
  test("does not render an unknown mark as a link", () => {
    const html = renderRichText(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "not a link",
            marks: [
              { type: "highlight", attrs: { href: "https://example.com" } },
            ],
          },
        ],
      } as unknown as RichTextContent),
    );

    expect(html).toBe("<p>not a link</p>");
    expect(html).not.toContain("<a ");
  });

  // A page renders whatever is in the row, so a malformed one must read as
  // nothing rather than throwing out of the render.
  test("does not throw on malformed input", () => {
    const cases: unknown[] = [
      { type: "doc", content: "not an array" },
      { type: "doc", content: [null] },
      { type: "doc", content: [{ type: "paragraph", content: "nope" }] },
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: 42 }] }],
      },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: "nope" }],
          },
        ],
      },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [null] }],
          },
        ],
      },
      { type: "doc", content: [{ type: "heading", attrs: "nope" }] },
    ];

    for (const value of cases) {
      expect(() =>
        renderRichText(value as unknown as RichTextDocument),
      ).not.toThrow();
    }
  });
});
