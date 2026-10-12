import { describe, expect, test } from "bun:test";
import {
  block,
  blockStoredSchema,
  image,
  link,
  list,
  richText,
  text,
} from "../index";
import { validateContent, withAdditionalFields } from "./index";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

const hero = block(
  "hero",
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
