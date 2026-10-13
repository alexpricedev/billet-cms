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
});
