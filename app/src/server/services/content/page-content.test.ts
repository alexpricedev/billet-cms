import { describe, expect, test } from "bun:test";
import {
  block,
  blockStoredSchema,
  group,
  link,
  list,
  MAX_RICH_TEXT_LIST_DEPTH,
  type PageTypeDefinition,
  pageType,
  pageTypeStoredSchema,
  richText,
  text,
  URL_PATTERN,
} from "@alexpricedev/billet-cms/fields";
import type { BlockTypeRecord, PageTypeRecord } from "./definitions";
import { formatIssues, linkLabelIssues } from "./drafts";
import {
  asPageContent,
  checkPageLimits,
  findUnavailableBlocks,
  mergeUnavailableBlocks,
  validatePageContent,
} from "./page-content";

const hero = block(
  "hero",
  { heading: text({ max: 80 }), cta: link({ required: false }) },
  () => null,
);
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

  // Button text is an editor rule, not a schema one, so it has to fail here
  // even though the schema accepted the link.
  test("refuses a filled link with no button text", () => {
    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [
        {
          type: "hero",
          heading: "Hi",
          cta: { type: "url", url: "https://example.com" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: "blocks.0.cta.label", message: "Button text is required." },
    ]);
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

  // The stored schema is compiled by Zod, whose messages name the validator
  // rather than the problem. A page's blocks take the same rewrite a slot's do,
  // so the editor sees "Use 80 characters or fewer.", not "Too big: expected
  // string to have <=80 characters" (review follow-up).
  test("rewrites a block field's validator message into plain language", () => {
    const tooLong = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "hero", heading: "x".repeat(81) }],
    });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.issues[0]).toEqual({
      path: "blocks.0.heading",
      message: "Use 80 characters or fewer.",
    });

    const wrongType = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "hero", heading: 42 }],
    });
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) return;
    expect(wrongType.issues[0]).toEqual({
      path: "blocks.0.heading",
      message: "Enter text.",
    });
  });

  // A page block's link field is a union of the page and url shapes, so the
  // validator reports the whole link. The message still has to land on the
  // empty page picker: "Choose a page." at `blocks.N.cta.pageId` (review round
  // 1).
  test("names an unchosen page link inside a block", () => {
    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [
        { type: "hero", heading: "Hi", cta: { type: "page", pageId: "" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: "blocks.0.cta.pageId", message: "Choose a page." },
    ]);
  });

  // The nesting bound is a whole-block issue with no field path. It must point
  // at the block itself — not a field called "(content)" — and keep its own
  // sentence rather than the generic "This value isn't valid." (review round
  // 1).
  test("points a whole-block issue at the block, keeping its message", () => {
    let node: unknown = { type: "paragraph", content: [] };
    for (let level = 0; level <= MAX_RICH_TEXT_LIST_DEPTH; level += 1) {
      node = {
        type: "bulletList",
        content: [{ type: "listItem", content: [node] }],
      };
    }

    const result = validatePageContent(pageTypeRecord(landing), registry, {
      blocks: [{ type: "prose", body: { type: "doc", content: [node] } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        path: "blocks.0",
        message: `Rich text lists may nest at most ${MAX_RICH_TEXT_LIST_DEPTH} deep.`,
      },
    ]);
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

  // Review round 2: a page type can drop a block it once allowed, and the block
  // type is still published and renderable, so a page that holds one must still
  // save and publish rather than being stranded.
  test("tolerates a not-allowed block when asked", () => {
    const strict = pageTypeRecord(
      pageType("landing", { allowedBlocks: [prose] }),
    );
    const content = { blocks: [{ type: "hero", heading: "Hi" }] };

    expect(
      validatePageContent(strict, registry, content, {
        allowNotAllowedBlocks: true,
      }).ok,
    ).toBe(true);

    // Without the tolerance the page type's rule still bites.
    expect(validatePageContent(strict, registry, content).ok).toBe(false);
  });

  test("still checks a tolerated not-allowed block's own fields", () => {
    const strict = pageTypeRecord(
      pageType("landing", { allowedBlocks: [prose] }),
    );
    const result = validatePageContent(
      strict,
      registry,
      { blocks: [{ type: "hero", heading: 42 }] },
      { allowNotAllowedBlocks: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("blocks.0.heading");
  });
});

describe("checkPageLimits", () => {
  test("requires a required block, naming it", () => {
    const issues = checkPageLimits(
      pageTypeRecord(
        pageType("landing", { allowedBlocks: [hero], requiredBlocks: [hero] }),
      ),
      [],
    );
    expect(issues[0]?.message).toContain("requires one");
    expect(issues[0]?.message).toContain('"hero"');
  });

  test("enforces a max of one hero", () => {
    const issues = checkPageLimits(pageTypeRecord(landing), [
      { type: "hero", heading: "One" },
      { type: "hero", heading: "Two" },
    ]);
    expect(
      issues.some((issue) => issue.message.includes("no more than 1")),
    ).toBe(true);
  });

  test("requires the hero to be first when the limit says top", () => {
    const issues = checkPageLimits(pageTypeRecord(landing), [
      { type: "prose", body: { type: "doc", content: [] } },
      { type: "hero", heading: "Late" },
    ]);
    expect(
      issues.some((issue) => issue.message.includes("has to be first")),
    ).toBe(true);
  });

  test("passes a page that satisfies every limit", () => {
    expect(
      checkPageLimits(pageTypeRecord(landing), [
        { type: "hero", heading: "First" },
      ]),
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

describe("formatIssues", () => {
  const PAGE_LINK = { type: "page", pageId: "" };

  test("names a page-mode link with no page chosen", () => {
    expect(
      formatIssues([{ path: ["cta", "pageId"], message: "Invalid UUID" }], {
        cta: { type: "page", pageId: "" },
      }),
    ).toEqual([{ path: "cta.pageId", message: "Choose a page." }]);
  });

  // The value never reaching the schema is the other half of "no page chosen":
  // a page-mode link with no `pageId` key at all.
  test("names a page-mode link whose pageId is missing", () => {
    expect(
      formatIssues(
        [
          {
            path: ["cta", "pageId"],
            message: "Invalid input: expected string, received undefined",
          },
        ],
        { cta: { type: "page" } },
      ),
    ).toEqual([{ path: "cta.pageId", message: "Choose a page." }]);
  });

  // A malformed non-empty id is a different problem: the editor picked a page
  // and the value is wrong, so it keeps the field's own message.
  test("keeps the plain message for a malformed page id", () => {
    expect(
      formatIssues([{ path: ["cta", "pageId"], message: "Invalid UUID" }], {
        cta: { type: "page", pageId: "not-a-uuid", label: "Go" },
      }),
    ).toEqual([{ path: "cta.pageId", message: "Enter a valid id." }]);
  });

  // A field that merely happens to be called `pageId` is not a page link.
  test("does not call a non-link pageId field a page", () => {
    expect(
      formatIssues([{ path: ["pageId"], message: "Invalid UUID" }], {
        pageId: "not-a-uuid",
      }),
    ).toEqual([{ path: "pageId", message: "Enter a valid id." }]);
  });

  test("walks a nested path to find the link", () => {
    expect(
      formatIssues(
        [{ path: ["hero", "cta", "pageId"], message: "Invalid UUID" }],
        {
          hero: { cta: PAGE_LINK },
        },
      ),
    ).toEqual([{ path: "hero.cta.pageId", message: "Choose a page." }]);
  });

  test("keeps an ordinary field message", () => {
    expect(
      formatIssues(
        [
          {
            path: ["heading"],
            message: "Too big: expected string to have <=80 characters",
          },
        ],
        { heading: "x".repeat(81) },
      ),
    ).toEqual([{ path: "heading", message: "Use 80 characters or fewer." }]);
  });

  test("singularises a one-character limit", () => {
    expect(
      formatIssues(
        [
          {
            path: ["heading"],
            message: "Too big: expected string to have <=1 characters",
          },
        ],
        { heading: "ab" },
      ),
    ).toEqual([{ path: "heading", message: "Use 1 character or fewer." }]);
  });

  // The link allowlist is stored as a JSON Schema `pattern`, so the validator's
  // message carries the pattern source and nothing about links. When it is that
  // allowlist that failed, the plain copy names the link.
  test("names a link whose allowlist pattern failed", () => {
    expect(
      formatIssues(
        [
          {
            path: ["cta", "url"],
            message: `Invalid string: must match pattern /${URL_PATTERN.source}/`,
          },
        ],
        { cta: { type: "url", url: "javascript:alert(1)", label: "Go" } },
      ),
    ).toEqual([
      { path: "cta.url", message: "Enter a full URL, starting with https://" },
    ]);
  });

  // Email and Phone are stored as url-mode links, so the scheme is what picks
  // the message; the person was typing into an email or phone box.
  test("names an email link with email copy", () => {
    expect(
      formatIssues(
        [
          {
            path: ["cta", "url"],
            message: `Invalid string: must match pattern /${URL_PATTERN.source}/`,
          },
        ],
        { cta: { type: "url", url: "mailto:", label: "Mail us" } },
      ),
    ).toEqual([
      {
        path: "cta.url",
        message: "Enter an email address like name@example.com",
      },
    ]);
  });

  test("names a phone link with phone copy", () => {
    expect(
      formatIssues(
        [
          {
            path: ["cta", "url"],
            message: `Invalid string: must match pattern /${URL_PATTERN.source}/`,
          },
        ],
        { cta: { type: "url", url: "tel:", label: "Call us" } },
      ),
    ).toEqual([
      {
        path: "cta.url",
        message: "Enter a phone number like +44 20 7946 0000",
      },
    ]);
  });

  // Button text is not in the schema (label is optional), so the write layer
  // checks it for a link that has a destination.
  const heroFields = blockStoredSchema(hero).fields;

  test("adds a button-text message for a filled link with no label", () => {
    expect(
      linkLabelIssues(heroFields, {
        cta: { type: "url", url: "https://example.com" },
      }),
    ).toEqual([{ path: "cta.label", message: "Button text is required." }]);
  });

  test("does not ask for button text on an unfilled page link", () => {
    expect(
      linkLabelIssues(heroFields, { cta: { type: "page", pageId: "" } }),
    ).toEqual([]);
  });

  // A field a deploy removed has no control in the form, so a label-less link
  // left in it must not make the block unpublishable.
  test("ignores a link in a field the metadata no longer declares", () => {
    expect(
      linkLabelIssues(heroFields, {
        removedCta: { type: "url", url: "https://example.com" },
      }),
    ).toEqual([]);
  });

  test("finds a link nested in a list and a group", () => {
    const nested = block(
      "nested",
      { links: list(link()), cta: group({ url: link() }) },
      () => null,
    );
    expect(
      linkLabelIssues(blockStoredSchema(nested).fields, {
        links: [{ type: "url", url: "https://example.com" }],
        cta: { url: { type: "url", url: "https://example.com" } },
      }),
    ).toEqual([
      { path: "links.0.label", message: "Button text is required." },
      { path: "cta.url.label", message: "Button text is required." },
    ]);
  });

  // A link that declares it has no text of its own never asks for any, in a
  // group, at the top level, or in a list.
  test("does not ask for button text on a link declared text:false", () => {
    const silent = block(
      "silent",
      {
        banner: group({ heading: text(), cta: link({ text: false }) }),
        cta: link({ text: false }),
        links: list(link({ text: false })),
      },
      () => null,
    );
    expect(
      linkLabelIssues(blockStoredSchema(silent).fields, {
        banner: { heading: "Hi", cta: { type: "url", url: "https://a.test" } },
        cta: { type: "url", url: "https://b.test" },
        links: [{ type: "url", url: "https://c.test" }],
      }),
    ).toEqual([]);
  });

  // The older shape of the same idea: a link beside its own text field. The
  // group's text carries the words, so a label-less link is not refused.
  test("does not ask for button text on a group link with a sibling text field", () => {
    const banner = block(
      "banner",
      { banner: group({ heading: text(), cta: link() }) },
      () => null,
    );
    expect(
      linkLabelIssues(blockStoredSchema(banner).fields, {
        banner: {
          heading: "Read this",
          cta: { type: "url", url: "https://example.com" },
        },
      }),
    ).toEqual([]);
  });

  test("still asks when the group's only sibling is not a text field", () => {
    const banner = block(
      "banner",
      { banner: group({ body: richText(), cta: link() }) },
      () => null,
    );
    expect(
      linkLabelIssues(blockStoredSchema(banner).fields, {
        banner: {
          body: { type: "doc", content: [] },
          cta: { type: "url", url: "https://example.com" },
        },
      }),
    ).toEqual([
      { path: "banner.cta.label", message: "Button text is required." },
    ]);
  });

  // A text field elsewhere in the block is not a sibling: only a group's own
  // children exempt its links, which keeps the quote's optional link refused.
  test("does not exempt a top-level or list link for a top-level text field", () => {
    const quote = block(
      "quote",
      { heading: text(), cta: link(), links: list(link()) },
      () => null,
    );
    expect(
      linkLabelIssues(blockStoredSchema(quote).fields, {
        heading: "Words",
        cta: { type: "url", url: "https://example.com" },
        links: [{ type: "url", url: "https://example.com" }],
      }),
    ).toEqual([
      { path: "cta.label", message: "Button text is required." },
      { path: "links.0.label", message: "Button text is required." },
    ]);
  });
});

describe("mergeUnavailableBlocks", () => {
  test("re-inserts a carried block at its original position", () => {
    const base = [
      { type: "hero", heading: "Top" },
      { type: "prose", body: { type: "doc", content: [] } },
      { type: "cta", label: "Go" },
    ];
    const submitted = [
      { type: "prose", body: { type: "doc", content: [] } },
      { type: "cta", label: "Go" },
    ];
    const unavailable = [
      { index: 0, type: "hero", reason: "removed" as const },
    ];

    expect(mergeUnavailableBlocks(submitted, base, unavailable)).toEqual(base);
  });

  test("keeps a middle position rather than appending to the end", () => {
    const base = [{ type: "prose" }, { type: "hero" }, { type: "cta" }];
    const submitted = [{ type: "prose" }, { type: "cta" }];
    const unavailable = [
      { index: 1, type: "hero", reason: "removed" as const },
    ];

    expect(
      mergeUnavailableBlocks(submitted, base, unavailable).map(
        (block) => block.type,
      ),
    ).toEqual(["prose", "hero", "cta"]);
  });

  test("returns the submitted list when nothing was carried", () => {
    const submitted = [{ type: "hero" }];
    expect(mergeUnavailableBlocks(submitted, [{ type: "hero" }], [])).toBe(
      submitted,
    );
  });

  // Review round 2: the Remove control on a flagged block sends its base index;
  // a block the editor removed on purpose must not be re-attached by the save.
  test("does not carry a block the editor explicitly removed", () => {
    const base = [
      { type: "prose", body: { type: "doc", content: [] } },
      { type: "hero", heading: "Gone" },
    ];
    const unavailable = [
      { index: 1, type: "hero", reason: "removed" as const },
    ];

    const merged = mergeUnavailableBlocks(
      [{ type: "prose", body: { type: "doc", content: [] } }],
      base,
      unavailable,
      [1],
    );
    expect(merged.map((block) => block.type)).toEqual(["prose"]);
  });

  test("still carries a flagged block the editor did not remove", () => {
    const base = [{ type: "hero", heading: "Kept" }];
    const unavailable = [
      { index: 0, type: "hero", reason: "removed" as const },
    ];

    expect(mergeUnavailableBlocks([], base, unavailable, [2])).toEqual(base);
  });
});
