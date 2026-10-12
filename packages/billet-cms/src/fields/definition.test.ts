import { describe, expect, test } from "bun:test";
import {
  block,
  blockContentSchema,
  blockStoredSchema,
  pageType,
  pageTypeContentSchema,
  pageTypeStoredSchema,
  slot,
} from "./definition";
import { richText, text } from "./field";

const hero = block(
  "hero",
  { heading: text({ max: 80 }) },
  (content) => content.heading,
);
const prose = block("prose", { body: richText() }, () => null);

describe("block", () => {
  test("keeps the fields and the render function", () => {
    const definition = block(
      "hero",
      { heading: text() },
      (content) => content.heading,
    );
    expect(definition.kind).toBe("block");
    expect(definition.name).toBe("hero");
    expect(definition.fields).toHaveProperty("heading");
    expect(definition.render({ heading: "Hi" })).toBe("Hi");
  });

  test("validates content against its fields", () => {
    const schema = blockContentSchema(hero);
    expect(schema.safeParse({ heading: "Hi" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ heading: "x".repeat(81) }).success).toBe(false);
  });

  test('rejects a field named "type", which collides with the page discriminator', () => {
    expect(() => block("weird", { type: text() }, () => null)).toThrow(
      /field named "type"/,
    );
  });
});

describe("blockStoredSchema", () => {
  test("flattens to the stored document with a schema hash", () => {
    const stored = blockStoredSchema(hero);

    expect(stored.format).toBe("billet-cms/schema");
    expect(stored.version).toBeGreaterThanOrEqual(2);
    expect(stored.name).toBe("hero");
    expect(stored.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.fields).toEqual([
      { name: "heading", kind: "text", required: true, max: 80 },
    ]);
  });

  test("hashes the same definition the same, and a changed one differently", () => {
    const same = blockStoredSchema(
      block("hero", { heading: text({ max: 80 }) }, () => null),
    );
    const changed = blockStoredSchema(
      block("hero", { heading: text({ max: 40 }) }, () => null),
    );

    expect(same.schemaHash).toBe(blockStoredSchema(hero).schemaHash);
    expect(changed.schemaHash).not.toBe(same.schemaHash);
  });
});

describe("slot", () => {
  test("names the block that fills it and derives the page from the name", () => {
    const definition = slot("home.hero", hero);
    expect(definition).toEqual({
      kind: "slot",
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });
  });

  test("takes a label, help and page override", () => {
    const definition = slot("footer.legal", prose, {
      label: "Legal",
      help: "The small print",
      page: "footer",
    });
    expect(definition).toMatchObject({
      label: "Legal",
      help: "The small print",
      page: "footer",
    });
  });
});

describe("pageType", () => {
  test("records the allowed, required and limited blocks", () => {
    const definition = pageType("Landing", {
      allowedBlocks: [hero, prose],
      requiredBlocks: [hero],
      limits: { hero: { max: 1, position: "top" } },
    });

    expect(definition.allowedBlocks.map(({ name }) => name)).toEqual([
      "hero",
      "prose",
    ]);
    expect(definition.requiredBlocks.map(({ name }) => name)).toEqual(["hero"]);
    expect(definition.limits).toEqual({
      hero: { max: 1, position: "top" },
    });
  });

  test("validates page content as an array of the allowed blocks", () => {
    const definition = pageType("Landing", {
      allowedBlocks: [hero, prose],
    });
    const schema = pageTypeContentSchema(definition);

    expect(schema.safeParse([{ type: "hero", heading: "Hi" }]).success).toBe(
      true,
    );
    expect(schema.safeParse([{ type: "unknown" }]).success).toBe(false);
  });

  test("stops at declaration when a required block isn't allowed", () => {
    expect(() =>
      pageType("Landing", { allowedBlocks: [hero], requiredBlocks: [prose] }),
    ).toThrow(/requires block "prose"/);
  });

  test("stops at declaration when limits name a block that isn't allowed", () => {
    expect(() =>
      pageType("Landing", { allowedBlocks: [hero], limits: { prose: {} } }),
    ).toThrow(/limits for "prose"/);
  });

  test("stops at declaration when a limit is not a non-negative integer", () => {
    expect(() =>
      pageType("Landing", {
        allowedBlocks: [hero],
        limits: { hero: { max: -1 } },
      }),
    ).toThrow(/non-negative integer/);
  });

  test("stops at declaration when a limit's min is above its max", () => {
    expect(() =>
      pageType("Landing", {
        allowedBlocks: [hero],
        limits: { hero: { min: 2, max: 1 } },
      }),
    ).toThrow(/min \(2\) must not be greater than max \(1\)/);
  });

  test("flattens to the stored document with a schema hash", () => {
    const stored = pageTypeStoredSchema(
      pageType("Landing", {
        allowedBlocks: [hero, prose],
        requiredBlocks: [hero],
        limits: { hero: { max: 1 } },
      }),
    );

    expect(stored.name).toBe("Landing");
    expect(stored.allowedBlocks).toEqual(["hero", "prose"]);
    expect(stored.requiredBlocks).toEqual(["hero"]);
    expect(stored.limits).toEqual({ hero: { max: 1 } });
    expect(stored.jsonSchema).toMatchObject({ type: "array" });
    expect(stored.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes the schema hash when only the label or help changes", () => {
    const plain = pageTypeStoredSchema(
      pageType("Landing", { allowedBlocks: [hero] }),
    );
    const relabelled = pageTypeStoredSchema(
      pageType("Landing", { allowedBlocks: [hero], label: "Landing page" }),
    );
    const helped = pageTypeStoredSchema(
      pageType("Landing", { allowedBlocks: [hero], help: "The home page" }),
    );

    expect(relabelled.schemaHash).not.toBe(plain.schemaHash);
    expect(helped.schemaHash).not.toBe(plain.schemaHash);
    expect(relabelled.label).toBe("Landing page");
  });
});
