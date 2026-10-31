import { describe, expect, test } from "bun:test";
import {
  block,
  blockStoredSchema,
  image,
  link,
  list,
  MAX_RICH_TEXT_LIST_DEPTH,
  richText,
  text,
} from "../index";
import { validateContent, withAdditionalFields } from "./index";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

const hero = block(
  "hero",
  { label: "Hero" },
  {
    heading: text({ max: 80 }),
    body: richText(),
    cta: link(),
    gallery: list(image({ minWidth: 1600 }), { max: 3 }),
  },
  () => null,
);

const stored = blockStoredSchema(hero).jsonSchema as Record<string, unknown>;

const validContent = {
  heading: "Hello",
  body: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }],
      },
    ],
  },
  cta: { type: "url", url: "https://example.com" },
  gallery: [{ mediaId: MEDIA_ID }],
};

describe("validateContent", () => {
  test("accepts content that matches the stored JSON Schema", () => {
    expect(validateContent(stored, validContent)).toEqual({
      success: true,
      data: validContent,
    });
  });

  test("rejects a value of the wrong type, with a path to point at", () => {
    const result = validateContent(stored, { ...validContent, heading: 5 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.some((issue) => issue.path[0] === "heading")).toBe(
      true,
    );
  });

  test("rejects an unknown node in the rich text document", () => {
    const result = validateContent(stored, {
      ...validContent,
      body: { type: "doc", content: [{ type: "script", content: [] }] },
    });

    expect(result.success).toBe(false);
  });

  // The compiled schema's rich text `$defs` are recursive, so a deeply nested
  // posted document would overflow the stack in `safeParse`. The bound is
  // checked first, so this comes back as an issue (not a RangeError).
  test("rejects a rich text document nested past the bound without overflowing", () => {
    let node: unknown = { type: "paragraph", content: [] };
    for (let level = 0; level <= MAX_RICH_TEXT_LIST_DEPTH; level += 1) {
      node = {
        type: "bulletList",
        content: [{ type: "listItem", content: [node] }],
      };
    }

    const result = validateContent(stored, {
      ...validContent,
      body: { type: "doc", content: [node] },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues[0]?.message).toContain("nest at most");
  });

  test("rejects an unknown top-level field by default", () => {
    const result = validateContent(stored, {
      ...validContent,
      removedField: "kept or not",
    });

    expect(result.success).toBe(false);
  });

  test("allows an unknown top-level field when removed fields must survive (Q4)", () => {
    const result = validateContent(
      stored,
      { ...validContent, removedField: "kept" },
      { allowAdditionalFields: true },
    );

    expect(result.success).toBe(true);
  });

  test("still refuses an unknown key inside a value when removed fields are allowed", () => {
    const result = validateContent(
      stored,
      { ...validContent, cta: { type: "url", url: "/x", extra: true } },
      { allowAdditionalFields: true },
    );

    expect(result.success).toBe(false);
  });

  test("refuses a value when a required field is missing", () => {
    const { heading: _omitted, ...withoutHeading } = validContent;
    const result = validateContent(stored, withoutHeading);

    expect(result.success).toBe(false);
  });

  // A union (a link's page/url shapes) reports one issue at the union itself.
  // Its issues are lifted to the field that failed, so a form can point at the
  // control: an empty `pageId` names `cta.pageId`, not the whole `cta` (review
  // round 1).
  test("lifts a union failure to the field that failed", () => {
    const result = validateContent(stored, {
      ...validContent,
      cta: { type: "page", pageId: "" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toEqual(["cta", "pageId"]);
  });
});

describe("withAdditionalFields", () => {
  test("opens only the root object, leaving nested schemas strict", () => {
    const opened = withAdditionalFields({
      type: "object",
      additionalProperties: false,
      properties: {
        nested: { type: "object", additionalProperties: false },
      },
    });

    expect(opened.additionalProperties).toBe(true);
    expect((opened.properties as Record<string, unknown>).nested).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });
});
