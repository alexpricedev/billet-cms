import { describe, expect, test } from "bun:test";
import {
  block,
  blockStoredSchema,
  type PageTypeDefinition,
  pageType,
  pageTypeStoredSchema,
  richText,
  text,
} from "@alexpricedev/billet-cms/fields";
import type { BlockTypeRecord, PageTypeRecord } from "./definitions";
import {
  asPageContent,
  checkPageLimits,
  findUnavailableBlocks,
  validatePageContent,
} from "./page-content";

const hero = block("hero", { heading: text({ max: 80 }) }, () => null);
const prose = block("prose", { body: richText() }, () => null);

const blockType = (
  definition: Parameters<typeof blockStoredSchema>[0],
  removedAt: Date | null = null,
): BlockTypeRecord => {
  const stored = blockStoredSchema(definition);
  return {
    id: stored.name,
    name: stored.name,
    jsonSchema: stored.jsonSchema,
    fields: stored.fields,
    schemaHash: stored.schemaHash,
    removedAt,
  };
};

const pageTypeRecord = (definition: PageTypeDefinition): PageTypeRecord => {
  const stored = pageTypeStoredSchema(definition);
  return {
    id: stored.name,
    name: stored.name,
    label: stored.label ?? null,
    help: stored.help ?? null,
    allowedBlocks: stored.allowedBlocks,
    requiredBlocks: stored.requiredBlocks,
    limits: stored.limits as Record<string, unknown>,
    jsonSchema: stored.jsonSchema,
    removedAt: null,
  };
};

const blockTypes = (...definitions: BlockTypeRecord[]) =>
  new Map(definitions.map((definition) => [definition.name, definition]));

const registry = blockTypes(blockType(hero), blockType(prose));

const landing = pageType("landing", {
  allowedBlocks: [hero, prose],
  limits: { hero: { max: 1, position: "top" } },
});

describe("asPageContent", () => {
  test("reads a blocks array from stored content", () => {
    expect(
      asPageContent({ blocks: [{ type: "hero", heading: "Hi" }] }),
    ).toEqual({ blocks: [{ type: "hero", heading: "Hi" }] });
  });

  test("tolerates a shape it doesn't recognise", () => {
    expect(asPageContent({ blocks: "nope" })).toEqual({ blocks: [] });
    expect(asPageContent({})).toEqual({ blocks: [] });
    expect(asPageContent({ blocks: [42, { noType: true }] })).toEqual({
      blocks: [],
    });
  });
});

describe("validatePageContent", () => {
  test("accepts a page that satisfies the page type", () => {
    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "hero", heading: "Hi" }],
    });
    expect(result.ok).toBe(true);
  });

  test("refuses a block the page type doesn't allow", () => {
    const result = validatePageContent(
      pageTypeRecord(pageType("landing", { allowedBlocks: [prose] })),
      registry,
      { blocks: [{ type: "hero", heading: "Hi" }] },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("blocks.0");
    expect(result.issues[0]?.message).toContain("isn't allowed");
  });

  test("points at the failing field inside a block", () => {
    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "hero", heading: 42 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("blocks.0.heading");
  });

  // Q4: a field a deploy dropped stays in the stored content; a save must not
  // refuse the block over a key nobody declares any more.
  test("tolerates an extra field inside a block on a save", () => {
    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "hero", heading: "Hi", dropped: true }],
    });
    expect(result.ok).toBe(true);
  });

  test("carries a removed block on a save but refuses it on publish", () => {
    const removed = blockTypes(blockType(hero, new Date()), blockType(prose));
    const content = { blocks: [{ type: "hero", heading: "Hi" }] };

    const saved = validatePageContent(
      pageTypeRecord(landing),
      removed,
      content,
      {
        allowUnavailableBlocks: true,
      },
    );
    expect(saved.ok).toBe(true);

    const published = validatePageContent(
      pageTypeRecord(landing),
      removed,
      content,
    );
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.issues[0]?.message).toContain("no longer published");
  });
});

describe("checkPageLimits", () => {
  test("requires a required block", () => {
    const issues = checkPageLimits(
      pageTypeRecord(
        pageType("landing", { allowedBlocks: [hero], requiredBlocks: [hero] }),
      ),
      [],
      registry,
    );
    expect(issues[0]?.message).toContain("requires one");
  });

  test("enforces a max of one hero", () => {
    const issues = checkPageLimits(
      pageTypeRecord(landing),
      [
        { type: "hero", heading: "One" },
        { type: "hero", heading: "Two" },
      ],
      registry,
    );
    expect(
      issues.some((issue) => issue.message.includes("no more than 1")),
    ).toBe(true);
  });

  test("requires the hero to be first when the limit says top", () => {
    const issues = checkPageLimits(
      pageTypeRecord(landing),
      [
        { type: "prose", body: { type: "doc", content: [] } },
        { type: "hero", heading: "Late" },
      ],
      registry,
    );
    expect(
      issues.some((issue) => issue.message.includes("has to be first")),
    ).toBe(true);
  });

  test("passes a page that satisfies every limit", () => {
    expect(
      checkPageLimits(
        pageTypeRecord(landing),
        [{ type: "hero", heading: "First" }],
        registry,
      ),
    ).toEqual([]);
  });
});

describe("findUnavailableBlocks", () => {
  test("names a removed block type with its index and reason", () => {
    const removed = blockTypes(blockType(hero, new Date()), blockType(prose));
    const found = findUnavailableBlocks(
      pageTypeRecord(landing),
      [{ type: "hero", heading: "Hi" }],
      removed,
    );
    expect(found).toEqual([{ index: 0, type: "hero", reason: "removed" }]);
  });

  test("names a block the page type no longer allows", () => {
    const found = findUnavailableBlocks(
      pageTypeRecord(pageType("landing", { allowedBlocks: [prose] })),
      [{ type: "hero", heading: "Hi" }],
      registry,
    );
    expect(found).toEqual([{ index: 0, type: "hero", reason: "not-allowed" }]);
  });

  test("reports nothing for a page whose blocks are all editable", () => {
    expect(
      findUnavailableBlocks(
        pageTypeRecord(landing),
        [{ type: "hero", heading: "Hi" }],
        registry,
      ),
    ).toEqual([]);
  });
});
