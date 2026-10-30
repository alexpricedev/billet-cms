import { describe, expect, test } from "bun:test";
import { MAX_ALT_LENGTH } from "../contract";
import {
  block,
  blockContentReadSchema,
  blockContentSchema,
  blockStoredSchema,
} from "./definition";
import {
  type Field,
  type FieldOptions,
  group,
  image,
  link,
  list,
  MAX_LIST_DEPTH,
  richText,
  text,
} from "./field";
import { MAX_RICH_TEXT_LIST_DEPTH } from "./rich-text";
import { URL_PATTERN } from "./url";

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
      block(
        "hero",
        { label: "Hero" },
        { heading: text({ max: 80 }) },
        () => null,
      ),
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

  test("rejects an unknown key on a node", () => {
    const document = {
      type: "doc",
      content: [{ type: "paragraph", content: [], extra: true }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects an unknown key on orderedList attrs, matching the JSON Schema", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1, extra: true },
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph" }],
            },
          ],
        },
      ],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects an unknown key on heading attrs, matching the JSON Schema", () => {
    const document = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2, extra: true } }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("flattens to JSON Schema even though the nodes are recursive", () => {
    const stored = blockStoredSchema(
      block("article", { label: "Article" }, { body: richText() }, () => null),
    );
    // The self-reference is emitted as `$ref`/`$defs`, not inlined forever.
    expect(stored.jsonSchema.$defs).toBeDefined();
    expect(properties(stored).body).toMatchObject({ type: "object" });
  });

  test("accepts nested lists", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(richText().schema.safeParse(document).success).toBe(true);
  });

  // The nodes are recursive, so an unbounded document overflows the stack in
  // the parse. The depth is checked before the recursive walk, so this is a
  // failed validation rather than a RangeError.
  test("rejects lists nested past the depth bound without overflowing", () => {
    const nested = (depth: number) => {
      let node: unknown = { type: "paragraph", content: [] };
      for (let level = 0; level < depth; level += 1) {
        node = {
          type: "bulletList",
          content: [{ type: "listItem", content: [node] }],
        };
      }
      return { type: "doc", content: [node] };
    };

    expect(
      richText().schema.safeParse(nested(MAX_RICH_TEXT_LIST_DEPTH)).success,
    ).toBe(true);

    const tooDeep = richText().schema.safeParse(
      nested(MAX_RICH_TEXT_LIST_DEPTH + 1),
    );
    expect(tooDeep.success).toBe(false);
  });

  test("rejects an inline node directly in the doc", () => {
    const document = {
      type: "doc",
      content: [{ type: "text", text: "loose" }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects a block node inside a paragraph", () => {
    const document = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "paragraph" }] }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects a paragraph where a list item belongs", () => {
    const document = {
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "paragraph" }] }],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects inline content inside a list item", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "text", text: "loose" }],
            },
          ],
        },
      ],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("rejects a javascript: link mark", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    };
    expect(richText().schema.safeParse(document).success).toBe(false);
  });

  test("accepts an https link mark", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    };
    expect(richText().schema.safeParse(document).success).toBe(true);
  });

  // The link mark and the link field share one allowlist, so the field's cases
  // have to hold through a rich text mark too — the same `href` on a site
  // anchor, reached by the other field kind.
  test("applies the URL allowlist to a rich text link mark", () => {
    const withHref = (href: string) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ],
    });

    for (const href of [
      "https://example.com/a?b=c#d",
      "http://example.com",
      "HTTPS://EXAMPLE.COM",
      "mailto:hello@example.com",
      "tel:+441234567890",
      // The editor shows a phone number with spaces; MCP and imports send it
      // that way too, so the allowlist takes it.
      "tel:+44 20 7946 0000",
      "/about/team",
      "#section",
    ]) {
      expect(
        richText().schema.safeParse(withHref(href)).success,
        `expected ${href} to be allowed`,
      ).toBe(true);
    }

    for (const href of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "//evil.example",
      "/\\evil.example",
      "https://",
    ]) {
      expect(
        richText().schema.safeParse(withHref(href)).success,
        `expected ${href} to be rejected`,
      ).toBe(false);
    }
  });
});

describe("field value types", () => {
  test("a required field is Field<T>, and required: false widens it to T | undefined", () => {
    // These two annotations are the test: they only compile if the value type
    // follows `required`. `bun run typecheck` is what fails if it regresses.
    const required: Field<string> = text();
    const optional: Field<string | undefined> = text({ required: false });

    expect(required.required).toBe(true);
    expect(optional.required).toBe(false);
  });

  // A non-literal flag (a variable, not an inline literal) could be either
  // way, so the value has to widen. Before this, `FieldOptions` did not match
  // `{ required: false }` and the field was typed as if it were required.
  test("a non-literal required flag widens to T | undefined", () => {
    const options: FieldOptions = { required: false };

    // The annotation is the test: it only compiles if FieldValue widened.
    const widened: Field<string | undefined> = text(options);

    expect(widened.required).toBe(false);
  });

  // `Field<T>` is covariant, so the annotations above can't fail to compile —
  // a `Field<string>` is a `Field<string | undefined>`. The other direction
  // proves the widening really happened: a value that may be absent is not a
  // `Field<string>`, so assigning one has to be a type error.
  test("a widened value can't pass for a required one", () => {
    const options: FieldOptions = { required: false };

    // @ts-expect-error text(options) is Field<string | undefined>, not Field<string>.
    const asRequired: Field<string> = text(options);
    // @ts-expect-error an inline required: false widens the same way.
    const explicit: Field<string> = text({ required: false });

    // Reached only at runtime; the expectations above are what is being tested.
    expect(asRequired.required).toBe(false);
    expect(explicit.required).toBe(false);
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

  // The per-use override becomes the rendered `alt` everywhere the image is
  // used, so it is capped at the contract's limit like the upload's own alt.
  // The CMS validates saved content against the published JSON Schema, so the
  // cap has to reach the schema, not just the site's Zod check.
  test("caps the per-use alt override at the contract's limit", () => {
    const field = image();
    expect(
      field.schema.safeParse({ mediaId: UUID, alt: "x".repeat(MAX_ALT_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      field.schema.safeParse({
        mediaId: UUID,
        alt: "x".repeat(MAX_ALT_LENGTH + 1),
      }).success,
    ).toBe(false);

    const stored = blockStoredSchema(
      block("hero", { label: "Hero" }, { photo: image() }, () => null),
    );
    const alt = properties(stored).photo?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(alt.alt).toMatchObject({ type: "string", maxLength: 1000 });
  });

  test("rejects an unknown key, matching the stored JSON Schema", () => {
    expect(image().schema.safeParse({ mediaId: UUID, extra: 1 }).success).toBe(
      false,
    );

    const stored = blockStoredSchema(
      block("hero", { label: "Hero" }, { photo: image() }, () => null),
    );
    expect(properties(stored).photo?.additionalProperties).toBe(false);
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

  test("accepts optional hover text on either branch", () => {
    const field = link();
    expect(
      field.schema.safeParse({
        type: "page",
        pageId: UUID,
        label: "Read more",
        title: "About our team",
      }).success,
    ).toBe(true);
    expect(
      field.schema.safeParse({
        type: "url",
        url: "https://example.com",
        title: "About our team",
      }).success,
    ).toBe(true);
  });

  test("publishes title as an optional string on both branches", () => {
    const stored = blockStoredSchema(
      block("cta", { label: "Call to action" }, { target: link() }, () => null),
    );
    const target = properties(stored).target as {
      oneOf: Array<{
        properties?: Record<string, { type?: string }>;
        required?: string[];
      }>;
    };
    for (const branch of target.oneOf) {
      expect(branch.properties?.title).toEqual({ type: "string" });
      expect(branch.required ?? []).not.toContain("title");
    }
  });

  test("rejects an empty or untyped value", () => {
    const field = link();
    expect(field.schema.safeParse({}).success).toBe(false);
    expect(field.schema.safeParse({ type: "url", url: "" }).success).toBe(
      false,
    );
  });

  test("rejects an unknown key on either branch, matching the JSON Schema", () => {
    const field = link();
    expect(
      field.schema.safeParse({ type: "url", url: "/about", extra: 1 }).success,
    ).toBe(false);
    expect(
      field.schema.safeParse({ type: "page", pageId: UUID, extra: 1 }).success,
    ).toBe(false);

    const stored = blockStoredSchema(
      block("cta", { label: "Call to action" }, { target: link() }, () => null),
    );
    const target = properties(stored).target as {
      oneOf: Array<{ additionalProperties?: boolean }>;
    };
    for (const branch of target.oneOf) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  test("names the kind in metadata", () => {
    expect(link({ label: "CTA" }).metadata("cta")).toEqual({
      name: "cta",
      kind: "link",
      required: true,
      label: "CTA",
    });
  });

  test("accepts http(s), mailto, tel, a relative path and a fragment", () => {
    const field = link();
    for (const url of [
      "https://example.com/a?b=c#d",
      "http://example.com",
      "HTTPS://EXAMPLE.COM",
      "mailto:hello@example.com",
      "tel:+441234567890",
      // The editor shows a phone number with spaces; MCP and imports send it
      // that way too, so the allowlist takes it.
      "tel:+44 20 7946 0000",
      "/about/team",
      "#section",
    ]) {
      expect(
        field.schema.safeParse({ type: "url", url }).success,
        `expected ${url} to be allowed`,
      ).toBe(true);
    }
  });

  test("rejects javascript:, data: and other non-allowlisted schemes", () => {
    const field = link();
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(
        field.schema.safeParse({ type: "url", url }).success,
        `expected ${url} to be rejected`,
      ).toBe(false);
    }
  });

  test("rejects a protocol-relative URL, which navigates off-site", () => {
    expect(
      link().schema.safeParse({ type: "url", url: "//evil.example" }).success,
    ).toBe(false);
  });

  test("rejects a backslash path, which a browser reads as protocol-relative", () => {
    const field = link();
    for (const url of ["/\\evil.example", "/about\\evil", "https://x/a\\b"]) {
      expect(
        field.schema.safeParse({ type: "url", url }).success,
        `expected ${JSON.stringify(url)} to be rejected`,
      ).toBe(false);
    }
  });

  test("rejects a scheme with nothing after it", () => {
    const field = link();
    for (const url of ["https://", "http://", "mailto:", "tel:"]) {
      expect(
        field.schema.safeParse({ type: "url", url }).success,
        `expected ${JSON.stringify(url)} to be rejected`,
      ).toBe(false);
    }
  });

  test("stores the allowlist as a JSON Schema pattern on the url branch", () => {
    const stored = blockStoredSchema(
      block("cta", { label: "Call to action" }, { target: link() }, () => null),
    );
    const target = properties(stored).target as {
      oneOf: Array<{ properties?: Record<string, { pattern?: string }> }>;
    };
    const urlBranch = target.oneOf.find(
      (branch) => branch.properties?.url !== undefined,
    );
    expect(urlBranch?.properties?.url?.pattern).toBe(URL_PATTERN.source);
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
      block(
        "hero",
        { label: "Hero" },
        { links: list(link(), { min: 1, max: 6 }) },
        () => null,
      ),
    );

    expect(properties(stored).links).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 6,
    });
  });

  test("rejects an optional item field", () => {
    expect(() => list(text({ required: false }))).toThrow(
      /items must be required/,
    );
  });

  test("bounds how deeply lists may nest", () => {
    // The editor recurses the metadata tree to build one control per nesting,
    // so an unbounded tree is an unbounded stack at render and on the client.
    let field: Field = text();
    for (let depth = 1; depth <= MAX_LIST_DEPTH; depth += 1) {
      field = list(field);
      expect(field.kind).toBe("list");
    }

    expect(() => list(field)).toThrow(
      new RegExp(`nest at most ${MAX_LIST_DEPTH} deep`),
    );
  });
});

describe("group", () => {
  test("nests its children's metadata under `fields`, in declared order", () => {
    const field = group(
      { title: text({ max: 60 }), body: text({ max: 200 }) },
      { label: "Step" },
    );

    expect(field.metadata("step")).toEqual({
      name: "step",
      kind: "group",
      required: true,
      label: "Step",
      fields: [
        { name: "title", kind: "text", required: true, max: 60 },
        { name: "body", kind: "text", required: true, max: 200 },
      ],
    });
  });

  // The shape `list()` alone could not express: two parallel lists leave
  // nothing tying titles[2] to bodies[2].
  test("repeats as a list of paired values", () => {
    const steps = list(group({ title: text(), body: text() }), { max: 2 });

    expect(
      steps.schema.safeParse([
        { title: "One", body: "First" },
        { title: "Two", body: "Second" },
      ]).success,
    ).toBe(true);
    expect(steps.schema.safeParse([{ title: "One" }]).success).toBe(false);
  });

  test("publishes a nested object in the block's JSON Schema", () => {
    const stored = blockStoredSchema(
      block(
        "card",
        { label: "Card" },
        { cta: group({ label: text(), href: text() }) },
      ),
    );

    expect(properties(stored).cta).toMatchObject({
      type: "object",
      required: ["label", "href"],
      additionalProperties: false,
    });
  });

  // Q4 at depth. A block gets its loose variant from blockContentReadSchema;
  // a group is one field, so it has to carry its own or dropping a child field
  // takes the whole block down to the site's fallback.
  test("is strict on save but tolerates a dropped child field on read", () => {
    const card = block(
      "card",
      { label: "Card" },
      { cta: group({ label: text() }) },
    );
    const stale = { cta: { label: "Go", removedLastDeploy: "x" } };

    expect(blockContentSchema(card).safeParse(stale).success).toBe(false);
    expect(blockContentReadSchema(card).safeParse(stale).success).toBe(true);
  });

  test("keeps the loose read through a list of groups", () => {
    const card = block(
      "card",
      { label: "Card" },
      {
        steps: list(group({ title: text() })),
      },
    );
    const stale = { steps: [{ title: "One", dropped: "x" }] };

    expect(blockContentReadSchema(card).safeParse(stale).success).toBe(true);
  });

  test("refuses an empty group", () => {
    expect(() => group({})).toThrow(/at least one field/);
  });

  test("checks its children's names", () => {
    expect(() => group({ "Not A Name": text() })).toThrow(/in a group/);
  });

  test("bounds nesting together with lists, not separately", () => {
    // One budget for both: the editor recurses the metadata tree without
    // caring which kind nested it.
    let field: Field = text();
    for (let depth = 1; depth <= MAX_LIST_DEPTH; depth += 1) {
      field = depth % 2 === 0 ? list(field) : group({ inner: field });
    }

    expect(() => group({ inner: field })).toThrow(
      new RegExp(`nest at most ${MAX_LIST_DEPTH} deep`),
    );
  });

  test("can be made optional", () => {
    const field = group({ label: text() }, { required: false });

    expect(field.schema.safeParse(undefined).success).toBe(true);
    expect(field.metadata("cta").required).toBe(false);
  });
});

describe("option validation", () => {
  test("rejects a negative or fractional count", () => {
    expect(() => text({ max: -1 })).toThrow(/non-negative integer/);
    expect(() => text({ max: 1.5 })).toThrow(/non-negative integer/);
    expect(() => list(text(), { min: -1 })).toThrow(/non-negative integer/);
    expect(() => image({ minWidth: -1 })).toThrow(/non-negative integer/);
  });

  test("rejects a list whose min is above its max", () => {
    expect(() => list(text(), { min: 3, max: 1 })).toThrow(
      /min \(3\) must not be greater than max \(1\)/,
    );
  });

  test("rejects an image aspect that isn't width:height", () => {
    expect(() => image({ aspect: "wide" })).toThrow(/"16:9"/);
    expect(() => image({ aspect: "16-9" })).toThrow(/"16:9"/);
    expect(() => image({ aspect: "16:9" })).not.toThrow();
  });
});
