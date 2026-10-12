import { describe, expect, test } from "bun:test";
import { block, blockStoredSchema } from "./definition";
import { image, link, list, richText, text } from "./field";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const properties = (stored: { jsonSchema: Record<string, unknown> }) =>
  stored.jsonSchema.properties as Record<string, Record<string, unknown>>;

describe("text", () => {
  test("carries its label, help and max in metadata", () => {
    const field = text({ label: "Heading", help: "Keep it short", max: 80 });
    expect(field.metadata("heading")).toEqual({
      name: "heading",
      kind: "text",
      required: true,
      label: "Heading",
      help: "Keep it short",
      max: 80,
    });
  });

  test("rejects a value longer than max", () => {
    expect(text({ max: 3 }).schema.safeParse("abcd").success).toBe(false);
    expect(text({ max: 3 }).schema.safeParse("abc").success).toBe(true);
  });

  test("is optional — and unmarked required — when required is false", () => {
    const field = text({ required: false });
    expect(field.schema.safeParse(undefined).success).toBe(true);
    expect(field.metadata("body").required).toBe(false);
  });

  test("appears in the block's JSON Schema with maxLength", () => {
    const stored = blockStoredSchema(
      block("hero", { heading: text({ max: 80 }) }, () => null),
    );

    expect(properties(stored).heading).toMatchObject({
      type: "string",
      maxLength: 80,
    });
    expect(stored.jsonSchema.required).toEqual(["heading"]);
  });
});

describe("richText", () => {
  test("names the kind in metadata", () => {
    expect(richText().metadata("body")).toEqual({
      name: "body",
      kind: "richText",
      required: true,
    });
  });

  test("accepts the allowed node set, marks and all", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello", marks: [{ type: "bold" }] }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [] }],
            },
          ],
        },
      ],
    };

    expect(richText().schema.safeParse(document).success).toBe(true);
  });

  test("rejects a node outside the allowed set", () => {
    const document = {
      type: "doc",
      content: [{ type: "table", content: [] }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("flattens to JSON Schema even though the nodes are recursive", () => {
    const stored = blockStoredSchema(
      block("article", { body: richText() }, () => null),
    );
    // The self-reference is emitted as `$ref`/`$defs`, not inlined forever.
    expect(stored.jsonSchema.$defs).toBeDefined();
    expect(properties(stored).body).toMatchObject({ type: "object" });
  });
});

describe("image", () => {
  test("carries the upload guidance in metadata", () => {
    const field = image({ label: "Photo", minWidth: 1600, aspect: "16:9" });
    expect(field.metadata("photo")).toEqual({
      name: "photo",
      kind: "image",
      required: true,
      label: "Photo",
      image: { minWidth: 1600, aspect: "16:9" },
    });
  });

  test("omits image guidance when none was given", () => {
    expect(image().metadata("photo").image).toBeUndefined();
  });

  test("requires a media id and allows a per-use alt override", () => {
    const field = image();
    expect(field.schema.safeParse({ mediaId: UUID }).success).toBe(true);
    expect(
      field.schema.safeParse({ mediaId: UUID, alt: "A fox" }).success,
    ).toBe(true);
    expect(field.schema.safeParse({ alt: "no id" }).success).toBe(false);
  });
});

describe("link", () => {
  test("accepts a CMS page by id or a free URL", () => {
    const field = link();
    expect(field.schema.safeParse({ type: "page", pageId: UUID }).success).toBe(
      true,
    );
    expect(
      field.schema.safeParse({ type: "url", url: "https://example.com" })
        .success,
    ).toBe(true);
  });

  test("rejects an empty or untyped value", () => {
    const field = link();
    expect(field.schema.safeParse({}).success).toBe(false);
    expect(field.schema.safeParse({ type: "url", url: "" }).success).toBe(
      false,
    );
  });

  test("names the kind in metadata", () => {
    expect(link({ label: "CTA" }).metadata("cta")).toEqual({
      name: "cta",
      kind: "link",
      required: true,
      label: "CTA",
    });
  });
});

describe("list", () => {
  test("nests the item's metadata under `of`", () => {
    const field = list(link(), { label: "Links", min: 1, max: 3 });
    const metadata = field.metadata("links");

    expect(metadata).toEqual({
      name: "links",
      kind: "list",
      required: true,
      label: "Links",
      min: 1,
      max: 3,
      of: { name: "item", kind: "link", required: true },
    });
  });

  test("enforces its min and max", () => {
    const field = list(text(), { min: 1, max: 2 });
    expect(field.schema.safeParse([]).success).toBe(false);
    expect(field.schema.safeParse(["a"]).success).toBe(true);
    expect(field.schema.safeParse(["a", "b", "c"]).success).toBe(false);
  });

  test("appears in the block's JSON Schema with minItems and maxItems", () => {
    const stored = blockStoredSchema(
      block("hero", { links: list(link(), { min: 1, max: 6 }) }, () => null),
    );

    expect(properties(stored).links).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 6,
    });
  });
});
