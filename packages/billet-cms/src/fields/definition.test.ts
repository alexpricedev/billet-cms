import { describe, expect, test } from "bun:test";
import {
  block,
  blockContentReadSchema,
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

  test("rejects unknown keys, matching the stored JSON Schema", () => {
    const schema = blockContentSchema(hero);
    expect(schema.safeParse({ heading: "Hi", extra: true }).success).toBe(
      false,
    );

    // The site-side rejection only matches the CMS if the stored JSON Schema
    // says the same thing, which is what `additionalProperties: false` is.
    expect(blockStoredSchema(hero).jsonSchema.additionalProperties).toBe(false);
  });

  test("the read schema strips an unknown key instead of rejecting it (Q4)", () => {
    const schema = blockContentReadSchema(hero);

    // A field the block has since dropped stays in the stored content; the read
    // path must strip it, not fail the whole block.
    expect(schema.safeParse({ heading: "Hi", extra: true }).success).toBe(true);
    expect(schema.parse({ heading: "Hi", extra: true })).toEqual({
      heading: "Hi",
    });

    // A genuine mismatch — a missing required field — still fails.
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("rejects an unknown key inside a page's block variant", () => {
    const definition = pageType("landing", { allowedBlocks: [hero] });
    const schema = pageTypeContentSchema(definition);

    expect(
      schema.safeParse([{ type: "hero", heading: "Hi", extra: 1 }]).success,
    ).toBe(false);
    expect(schema.safeParse([{ type: "hero", heading: "Hi" }]).success).toBe(
      true,
    );
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
      previewPath: "/",
    });
  });

  test("takes a label, help, page and preview path override", () => {
    const definition = slot("footer.legal", prose, {
      label: "Legal",
      help: "The small print",
      page: "footer",
      previewPath: "/terms",
    });
    expect(definition).toMatchObject({
      label: "Legal",
      help: "The small print",
      page: "footer",
      previewPath: "/terms",
    });
  });

  // `previewPath` is opened in the editor's browser by the CMS, so a value that
  // isn't a same-origin path would navigate them off-site. It is caught at the
  // declaration, next to the mistake.
  test("accepts a same-origin previewPath", () => {
    expect(() =>
      slot("home.hero", hero, { previewPath: "/contact" }),
    ).not.toThrow();
    expect(() => slot("home.hero", hero, { previewPath: "/" })).not.toThrow();
  });

  test("refuses a previewPath that isn't a same-origin path", () => {
    for (const previewPath of [
      "//evil.example/phish",
      "/\\evil.example",
      "https://evil.example",
      "about",
      "",
    ]) {
      expect(() => slot("home.hero", hero, { previewPath })).toThrow(
        /invalid previewPath/,
      );
    }
  });
});

describe("pageType", () => {
  test("records the allowed, required and limited blocks", () => {
    const definition = pageType("landing", {
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
    const definition = pageType("landing", {
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
      pageType("landing", { allowedBlocks: [hero], requiredBlocks: [prose] }),
    ).toThrow(/requires block "prose"/);
  });

  test("stops at declaration when limits name a block that isn't allowed", () => {
    expect(() =>
      pageType("landing", { allowedBlocks: [hero], limits: { prose: {} } }),
    ).toThrow(/limits for "prose"/);
  });

  test("stops at declaration when a limit is not a non-negative integer", () => {
    expect(() =>
      pageType("landing", {
        allowedBlocks: [hero],
        limits: { hero: { max: -1 } },
      }),
    ).toThrow(/non-negative integer/);
  });

  test("stops at declaration when a limit's min is above its max", () => {
    expect(() =>
      pageType("landing", {
        allowedBlocks: [hero],
        limits: { hero: { min: 2, max: 1 } },
      }),
    ).toThrow(/min \(2\) must not be greater than max \(1\)/);
  });

  test("flattens to the stored document with a schema hash", () => {
    const stored = pageTypeStoredSchema(
      pageType("landing", {
        allowedBlocks: [hero, prose],
        requiredBlocks: [hero],
        limits: { hero: { max: 1 } },
      }),
    );

    expect(stored.name).toBe("landing");
    expect(stored.allowedBlocks).toEqual(["hero", "prose"]);
    expect(stored.requiredBlocks).toEqual(["hero"]);
    expect(stored.limits).toEqual({ hero: { max: 1 } });
    expect(stored.jsonSchema).toMatchObject({ type: "array" });
    expect(stored.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes the schema hash when only the label or help changes", () => {
    const plain = pageTypeStoredSchema(
      pageType("landing", { allowedBlocks: [hero] }),
    );
    const relabelled = pageTypeStoredSchema(
      pageType("landing", { allowedBlocks: [hero], label: "Landing page" }),
    );
    const helped = pageTypeStoredSchema(
      pageType("landing", { allowedBlocks: [hero], help: "The home page" }),
    );

    expect(relabelled.schemaHash).not.toBe(plain.schemaHash);
    expect(helped.schemaHash).not.toBe(plain.schemaHash);
    expect(relabelled.label).toBe("Landing page");
  });
});

describe("name validation", () => {
  test("accepts valid block, field and page type names", () => {
    expect(() => block("hero", { heading: text() }, () => null)).not.toThrow();
    expect(() =>
      block("hero-2", { heroBanner_1: text() }, () => null),
    ).not.toThrow();
    expect(() => block("a", { a: text() }, () => null)).not.toThrow();
    expect(() =>
      block("a".repeat(64), { heading: text() }, () => null),
    ).not.toThrow();
    expect(() => pageType("landing", {})).not.toThrow();
    expect(() => pageType("blogPost", {})).not.toThrow();
  });

  test("rejects an invalid block name", () => {
    for (const name of [
      "Hero",
      "1hero",
      "-hero",
      "hero!",
      "héro",
      "",
      "a".repeat(65),
    ]) {
      expect(() => block(name, { heading: text() }, () => null)).toThrow(
        /Invalid block name/,
      );
    }
  });

  test("rejects an invalid field name, naming the block it is in", () => {
    for (const field of ["Heading", "1heading", "head ing", "héad", ""]) {
      expect(() => block("hero", { [field]: text() }, () => null)).toThrow(
        /Invalid field name .* in block "hero"/,
      );
    }
  });

  test("rejects an invalid page type name", () => {
    for (const name of ["Landing", "1landing", "land ing", "héro", ""]) {
      expect(() => pageType(name, {})).toThrow(/Invalid page type name/);
    }
  });

  test("accepts valid slot names, including a dotted page prefix", () => {
    for (const name of [
      "home",
      "home.hero",
      "footer.legal-notice",
      "a".repeat(64),
    ]) {
      expect(() => slot(name, hero)).not.toThrow();
    }
  });

  test("rejects an invalid slot name", () => {
    for (const name of [
      "Home.hero",
      "1home",
      ".hero",
      "home hero",
      "home/hero",
      "",
    ]) {
      expect(() => slot(name, hero)).toThrow(/Invalid slot name/);
    }
  });
});
