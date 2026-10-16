import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { MAX_ALT_LENGTH } from "../contract";
import { block, image, text } from "../fields";
import { blockStoredSchema } from "../fields/definition";
import { createContentReader, getSlot } from "./slots";

/** A pool whose first query throws, standing in for a CMS that isn't reachable. */
const throwingSql = {
  unsafe: () => {
    throw new Error('relation "cms_meta" does not exist');
  },
} as unknown as SQL;

const HERO_CONTENT = { heading: "Cached hero" };

/**
 * A pool that answers the reader's joined slot query from memory, so a test can
 * make the version check fail without a database. `versionFails` stands in for
 * the CMS becoming unreachable between two reads: the content the cache already
 * holds is still the last published revision the site saw.
 */
const fakeSql = (
  content: Record<string, unknown> | null = HERO_CONTENT,
  jsonSchema: Record<string, unknown> = { type: "object" },
) => {
  const state = {
    now: 0,
    version: 1,
    versionReads: 0,
    slotReads: 0,
    versionFails: false,
  };
  const sql = {
    unsafe: (query: string) => {
      if (query.includes("cms_meta")) {
        state.versionReads += 1;
        if (state.versionFails) {
          throw new Error('relation "cms_meta" does not exist');
        }
        return Promise.resolve([{ content_version: state.version }]);
      }
      if (query.includes("cms_slots")) {
        // The slot, its block type and its published revision, as the one
        // joined query returns them.
        state.slotReads += 1;
        return Promise.resolve([
          {
            id: "slot-1",
            name: "home.hero",
            block_name: "hero",
            removed_at: null,
            published_revision_id: content === null ? null : "rev-1",
            block_found: "hero",
            // Permissive by default: the stored contract accepts the row, so
            // any rejection a test below sees comes from the site's own block
            // schema. A test can pass a real published schema instead.
            json_schema: jsonSchema,
            block_removed_at: null,
            revision_found: content === null ? null : "rev-1",
            content,
          },
        ]);
      }
      return Promise.resolve([]);
    },
  } as unknown as SQL;

  return { state, sql };
};

describe("createContentReader", () => {
  // The read path is a public page's: it must answer "nothing" rather than
  // throwing, whatever the database says. The site keeps working when the CMS
  // is down or not set up.
  test("reports and returns null, never throwing, when the CMS isn't readable", async () => {
    const skipped: string[] = [];
    const reader = createContentReader({
      sql: throwingSql,
      onSkip: (message) => skipped.push(message),
    });

    expect(await reader.getSlot("home.hero")).toBeNull();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('could not read slot "home.hero"');
    expect(skipped[0]).toContain("cms_meta");
  });

  // A failed content_version check is transient — the CMS is down, or
  // mid-migration — and must not take away content the process already has.
  test("keeps serving cached content when the version check fails, and backs off", async () => {
    const { state, sql } = fakeSql();
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      now: () => state.now,
      onSkip: (message) => skipped.push(message),
    });

    const cached = await reader.getSlot("home.hero");
    expect(cached).toEqual(HERO_CONTENT);
    expect(state.versionReads).toBe(1);

    // Past the interval, the CMS goes away between reads.
    state.versionFails = true;
    state.now = 1000;

    // The cached revision is still served, and the failure is reported.
    const served = await reader.getSlot("home.hero");
    expect(served).toEqual(HERO_CONTENT);
    expect(skipped.some((line) => line.includes("content version"))).toBe(true);
    expect(state.versionReads).toBe(2);

    // Backed off: a request inside the next interval does not re-query.
    state.now = 1100;
    const backedOff = await reader.getSlot("home.hero");
    expect(backedOff).toEqual(HERO_CONTENT);
    expect(state.versionReads).toBe(2);
  });

  test("returns null when the version check fails with nothing cached", async () => {
    const { state, sql } = fakeSql();
    state.versionFails = true;
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      now: () => state.now,
      onSkip: (message) => skipped.push(message),
    });

    expect(await reader.getSlot("home.hero")).toBeNull();
    expect(state.versionReads).toBe(1);
    expect(
      skipped.some((line) => line.includes('could not read slot "home.hero"')),
    ).toBe(true);

    // Backed off even with nothing cached: the next request inside the interval
    // does not hit the broken database again.
    state.now = 100;
    expect(await reader.getSlot("home.hero")).toBeNull();
    expect(state.versionReads).toBe(1);
  });
});

describe("getSlot with the site's own block", () => {
  const hero = block("hero", { heading: text() }, () => null);

  test("parses the content against the block's own Zod schema", async () => {
    const { sql } = fakeSql();
    const reader = createContentReader({ sql, onSkip: () => {} });

    const content = await reader.getSlot("home.hero", { block: hero });
    expect(content).toEqual(HERO_CONTENT);
  });

  test("skips content the block's own schema rejects, and logs it", async () => {
    const { sql } = fakeSql();
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      onSkip: (message) => skipped.push(message),
    });

    // The stored contract accepts `heading` as anything; the site's `image`
    // field does not, which is what a deploy that changed the field produces.
    const expectsImage = block("hero", { heading: image() }, () => null);
    const content = await reader.getSlot("home.hero", { block: expectsImage });

    expect(content).toBeNull();
    expect(skipped.some((line) => line.includes("block's own schema"))).toBe(
      true,
    );
  });

  // Q4: a deploy drops a field, the stored content keeps it, and the read side
  // must return the declared fields rather than skipping the whole slot.
  test("keeps the declared fields when the stored content has an extra key", async () => {
    const { sql } = fakeSql({ ...HERO_CONTENT, dropped: "old field" });
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      onSkip: (message) => skipped.push(message),
    });

    const content = await reader.getSlot("home.hero", { block: hero });

    expect(content).toEqual(HERO_CONTENT);
    expect(content).not.toHaveProperty("dropped");
    expect(skipped).toEqual([]);
  });

  // The convenience helper is the documented entry point; this asserts the
  // overload infers the content type from the definition at compile time too.
  test("the convenience getSlot infers the block's content type", async () => {
    const { sql } = fakeSql();
    const content = await getSlot(sql, "home.hero", { block: hero });

    const heading: string | undefined = content?.heading;
    expect(heading).toBe("Cached hero");
  });

  // A site forwards `preview` straight from the catch-all's render context,
  // where it is `null` for a published read. That must be the same read as
  // omitting it, not a type error the site has to branch around.
  test("the convenience getSlot forwards a null preview as published", async () => {
    const { sql } = fakeSql();
    const content = await getSlot(sql, "home.hero", {
      block: hero,
      preview: null,
    });

    expect(content?.heading).toBe("Cached hero");
  });
});

describe("getSlot with preview access", () => {
  /**
   * A pool with a published revision and a newer draft, returning the joined
   * slot row the reader now selects in one query — including the newest
   * revision the `LEFT JOIN LATERAL` brings back.
   */
  const previewSql = (published = "Published", draft = "Draft") => {
    const state = { version: 1, slotReads: 0 };
    const sql = {
      unsafe: (query: string) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "rev-1",
              content: { heading: published },
              latest_revision_id: "rev-2",
              latest_content: { heading: draft },
            },
          ]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    return { state, sql };
  };

  const reader = (sql: SQL) => createContentReader({ sql, onSkip: () => {} });

  test("the token's own slot reads its newest draft", async () => {
    const content = await reader(previewSql().sql).getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });
    expect(content).toEqual({ heading: "Draft" });
  });

  test("previewing another slot leaves this one published", async () => {
    const content = await reader(previewSql().sql).getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-2" },
    });
    expect(content).toEqual({ heading: "Published" });
  });

  test("a page token never shows a slot's draft", async () => {
    const content = await reader(previewSql().sql).getSlot("home.hero", {
      preview: { subjectType: "page", subjectId: "slot-1" },
    });
    expect(content).toEqual({ heading: "Published" });
  });

  test("a preview read bypasses the cache for its own slot", async () => {
    const { sql } = previewSql();
    const slots = reader(sql);

    // Warm the published cache.
    expect((await slots.getSlot("home.hero"))?.heading).toBe("Published");

    // The preview of its own slot must not be served from it.
    const draft = await slots.getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });
    expect(draft).toEqual({ heading: "Draft" });

    // And it must not have written the draft into the published cache.
    expect((await slots.getSlot("home.hero"))?.heading).toBe("Published");
  });

  test("a null preview is the published read", async () => {
    const content = await reader(previewSql().sql).getSlot("home.hero", {
      preview: null,
    });
    expect(content).toEqual({ heading: "Published" });
  });

  // The point of keeping the cache during a preview: a token for one slot must
  // not force every other slot on the page to re-read.
  test("a slot token reads slots it does not cover from the cache", async () => {
    const state = { version: 1, slotReads: 0 };
    const sql = {
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          const name = params[0] as string;
          return Promise.resolve([
            {
              id: `slot-${name}`,
              name,
              block_name: "hero",
              removed_at: null,
              published_revision_id: "rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "rev-1",
              content: { heading: `${name} published` },
              latest_revision_id: "rev-2",
              latest_content: { heading: "draft" },
            },
          ]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;
    const slots = reader(sql);
    const preview = { subjectType: "slot" as const, subjectId: "slot-a" };

    // Warm both slots.
    await slots.getSlot("a", { preview });
    await slots.getSlot("b", { preview });
    const afterWarmup = state.slotReads;

    // Only the token's own slot re-reads (one joined query); the other is
    // served from the cache with no query at all.
    await slots.getSlot("a", { preview });
    expect(state.slotReads).toBe(afterWarmup + 1);
    await slots.getSlot("b", { preview });
    expect(state.slotReads).toBe(afterWarmup + 1);
  });

  // A slot that has never been published still has a row and an id, so its
  // first draft can be previewed before the slot ever goes live.
  test("previews the first draft of a never-published slot", async () => {
    const state = { version: 1, slotReads: 0 };
    const sql = {
      unsafe: (query: string) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: null,
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: null,
              content: null,
              latest_revision_id: "rev-2",
              latest_content: { heading: "First draft" },
            },
          ]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;

    const content = await reader(sql).getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });
    expect(content).toEqual({ heading: "First draft" });
  });
});

describe("slot query counts", () => {
  /** A pool with `names` as published slots, counting the queries it answers. */
  const countingSql = (names: string[]) => {
    const state = { version: 1, versionReads: 0, slotReads: 0 };
    const sql = {
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_meta")) {
          state.versionReads += 1;
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          const name = params[0] as string;
          if (!names.includes(name)) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: `slot-${name}`,
              name,
              block_name: "hero",
              removed_at: null,
              published_revision_id: `rev-${name}`,
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: `rev-${name}`,
              content: { heading: name },
            },
          ]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;
    return { state, sql };
  };

  test("a cold slot costs one version read and one query", async () => {
    const { state, sql } = countingSql(["a"]);
    const reader = createContentReader({ sql, onSkip: () => {} });

    const content = await reader.getSlot("a");
    expect(content).toEqual({ heading: "a" });
    expect(state.versionReads).toBe(1);
    expect(state.slotReads).toBe(1);
  });

  test("four slots after a publish cost one query each", async () => {
    const { state, sql } = countingSql(["a", "b", "c", "d"]);
    let now = 0;
    const reader = createContentReader({
      sql,
      now: () => now,
      onSkip: () => {},
    });

    for (const name of ["a", "b", "c", "d"]) await reader.getSlot(name);
    const slotReads = state.slotReads;
    const versionReads = state.versionReads;

    // A publish moves the version, dropping every entry: a page with four slots
    // then costs one version read and one query per slot, not three per slot.
    state.version += 1;
    now += 1000;
    for (const name of ["a", "b", "c", "d"]) await reader.getSlot(name);
    expect(state.slotReads - slotReads).toBe(4);
    expect(state.versionReads - versionReads).toBe(1);
  });

  test("simultaneous cold reads of one slot share one load", async () => {
    const { state, sql } = countingSql(["a"]);
    const reader = createContentReader({ sql, onSkip: () => {} });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reader.getSlot("a")),
    );
    for (const result of results) expect(result).toEqual({ heading: "a" });
    expect(state.versionReads).toBe(1);
    expect(state.slotReads).toBe(1);
  });

  // The preview used to read the slot for the cache check, then the slot again,
  // then the newest revision's id, then that revision's content. The `LEFT JOIN
  // LATERAL` folds the newest revision into the preview's own slot read, so the
  // two extra `cms_revisions` queries are gone.
  test("a preview of the token's own slot folds the newest revision into the slot read", async () => {
    const state = {
      version: 1,
      versionReads: 0,
      slotReads: 0,
      revisionReads: 0,
    };
    const sql = {
      unsafe: (query: string) => {
        if (query.includes("cms_meta")) {
          state.versionReads += 1;
          return Promise.resolve([{ content_version: state.version }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "rev-1",
              content: { heading: "Published" },
              latest_revision_id: "rev-2",
              latest_content: { heading: "Draft" },
            },
          ]);
        }
        if (query.includes("cms_revisions")) {
          state.revisionReads += 1;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;
    const reader = createContentReader({ sql, onSkip: () => {} });

    const content = await reader.getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });

    expect(content).toEqual({ heading: "Draft" });
    // Two slot reads: the cached-slot lookup that matches the token's subject,
    // then the preview's own joined read. No separate `cms_revisions` queries.
    expect(state.slotReads).toBe(2);
    expect(state.revisionReads).toBe(0);
    expect(state.versionReads).toBe(1);
  });

  test("a preview whose newest revision is the published one reuses the joined content", async () => {
    const state = { slotReads: 0, revisionReads: 0 };
    const sql = {
      unsafe: (query: string) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: 1 }]);
        }
        if (query.includes("cms_slots")) {
          state.slotReads += 1;
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "rev-1",
              block_found: "hero",
              json_schema: { type: "object" },
              block_removed_at: null,
              revision_found: "rev-1",
              content: { heading: "Published, and newest" },
              latest_revision_id: "rev-1",
              // Deliberately different: the published content must win, or a
              // stale lateral row could shadow the published revision.
              latest_content: { heading: "should not be used" },
            },
          ]);
        }
        if (query.includes("cms_revisions")) {
          state.revisionReads += 1;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    } as unknown as SQL;
    const reader = createContentReader({ sql, onSkip: () => {} });

    const content = await reader.getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });

    expect(content).toEqual({ heading: "Published, and newest" });
    expect(state.revisionReads).toBe(0);
  });
});

// r1-5: the published JSON Schema carries the per-use alt cap, and the read
// path validates stored content against that schema. An alt already published
// at the limit still reads; one each character past it is refused (the upgrade
// note in `.context/`).
describe("getSlot stored-schema image alt", () => {
  const photo = block("hero", { photo: image() }, () => null);
  const storedSchema = blockStoredSchema(photo).jsonSchema;
  const mediaId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const contentWithAlt = (length: number) => ({
    photo: { mediaId, alt: "x".repeat(length) },
  });

  test("accepts a stored image alt at the contract limit", async () => {
    const { sql } = fakeSql(contentWithAlt(MAX_ALT_LENGTH), storedSchema);
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      onSkip: (message) => skipped.push(message),
    });

    expect(await reader.getSlot("home.hero")).not.toBeNull();
    expect(skipped).toEqual([]);
  });

  test("refuses a stored image alt past the contract limit", async () => {
    const { sql } = fakeSql(contentWithAlt(MAX_ALT_LENGTH + 1), storedSchema);
    const skipped: string[] = [];
    const reader = createContentReader({
      sql,
      onSkip: (message) => skipped.push(message),
    });

    expect(await reader.getSlot("home.hero")).toBeNull();
    expect(skipped.some((line) => line.includes("no longer validates"))).toBe(
      true,
    );
  });
});
