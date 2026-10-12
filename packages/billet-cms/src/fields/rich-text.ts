/**
 * Rich text, stored as structured JSON.
 *
 * Q1 settled the format as ProseMirror/Tiptap JSON, restricted to a small
 * allowed set: paragraphs, `h2`-`h4` headings, bullet and ordered lists, links,
 * bold and italic. The editor that produces it ships in the CMS (Phase 3); this
 * schema is what both sides validate against and what the plugin renders.
 *
 * Rejecting an unknown node is the point: the document may come from an editor
 * whose toolbar is one config change away from allowing more, so the stored
 * shape is checked rather than trusted.
 */
import { z } from "zod";

export type RichTextMarkType = "bold" | "italic" | "link";

export interface RichTextMark {
  type: RichTextMarkType;
  attrs?: { href?: string; target?: string };
}

export interface RichTextText {
  type: "text";
  text: string;
  marks?: RichTextMark[];
}

export interface RichTextHardBreak {
  type: "hardBreak";
}

export type RichTextInline = RichTextText | RichTextHardBreak;

export type RichTextNodeType =
  | "paragraph"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "listItem";

export interface RichTextNode {
  type: RichTextNodeType;
  attrs?: { level?: 2 | 3 | 4; start?: number };
  content?: RichTextContent[];
}

export type RichTextContent = RichTextNode | RichTextInline;

export interface RichTextDocument {
  type: "doc";
  content?: RichTextContent[];
}

const linkMark = z.object({
  type: z.literal("link"),
  attrs: z.object({
    href: z.string().min(1),
    target: z.enum(["_self", "_blank"]).optional(),
  }),
});

const mark: z.ZodType<RichTextMark> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  linkMark,
]);

const inline: z.ZodType<RichTextInline> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    marks: z.array(mark).optional(),
  }),
  z.object({ type: z.literal("hardBreak") }),
]);

// Recursive: a list item holds block nodes, which may be lists themselves. The
// `z.lazy` wrapper is what lets the self-reference resolve, and `toJSONSchema`
// emits it as `$ref`/`$defs` rather than looping.
const node: z.ZodType<RichTextNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("paragraph"),
      content: z.array(z.union([node, inline])).optional(),
    }),
    z.object({
      type: z.literal("heading"),
      attrs: z.object({
        level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      }),
      content: z.array(z.union([node, inline])).optional(),
    }),
    z.object({
      type: z.literal("bulletList"),
      content: z.array(node),
    }),
    z.object({
      type: z.literal("orderedList"),
      attrs: z
        .object({ start: z.number().int().positive().optional() })
        .optional(),
      content: z.array(node),
    }),
    z.object({
      type: z.literal("listItem"),
      content: z.array(node),
    }),
  ]),
);

/** The Zod schema for a rich text field's stored value. */
export const richTextSchema: z.ZodType<RichTextDocument> = z.object({
  type: z.literal("doc"),
  content: z.array(z.union([node, inline])).optional(),
});
