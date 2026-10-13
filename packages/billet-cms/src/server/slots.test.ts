import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { block, image, text } from "../fields";
import { createContentReader, getSlot } from "./slots";

/** A pool whose first query throws, standing in for a CMS that isn't reachable. */
const throwingSql = {
  unsafe: () => {
    throw new Error('relation "cms_meta" does not exist');
  },
} as unknown as SQL;

const HERO_CONTENT = { heading: "Cached hero" };

/**
 * A pool that answers the reader's four queries from memory, so a test can make
 * the version check fail without a database. `versionFails` stands in for the
 * CMS becoming unreachable between two reads: the content the cache already
 * holds is still the last published revision the site saw.
 */
const fakeSql = (content: Record<string, unknown> = HERO_CONTENT) => {
  const state = { now: 0, version: 1, versionReads: 0, versionFails: false };
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
        return Promise.resolve([
          {
            id: "slot-1",
            block_name: "hero",
            removed_at: null,
            published_revision_id: "rev-1",
          },
        ]);
      }
      if (query.includes("cms_block_types")) {
        // Permissive on purpose: the stored contract accepts the row, so any
        // rejection a test below sees comes from the site's own block schema.
        return Promise.resolve([
          { json_schema: { type: "object" }, removed_at: null },
        ]);
      }
      if (query.includes("cms_revisions")) {
        return Promise.resolve([{ content }]);
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
   * A pool with a published revision and a newer draft. Preview reads must
   * bypass the cache, so the version check it queries is deliberately left to
   * return a value the cache would otherwise keep serving from.
   */
  const previewSql = (published = "Published", draft = "Draft") =>
    ({
      unsafe: (query: string, params: unknown[] = []) => {
        if (query.includes("cms_meta")) {
          return Promise.resolve([{ content_version: 1 }]);
        }
        if (query.includes("cms_slots")) {
          return Promise.resolve([
            {
              id: "slot-1",
              name: "home.hero",
              block_name: "hero",
              removed_at: null,
              published_revision_id: "rev-1",
            },
          ]);
        }
        if (query.includes("cms_block_types")) {
          return Promise.resolve([
            { json_schema: { type: "object" }, removed_at: null },
          ]);
        }
        if (query.includes("cms_revisions")) {
          if (query.includes("LIMIT 1") && query.includes("target_id")) {
            return Promise.resolve([{ id: "rev-2" }]);
          }
          return Promise.resolve([
            { content: { heading: params[0] === "rev-2" ? draft : published } },
          ]);
        }
        return Promise.resolve([]);
      },
    }) as unknown as SQL;

  const reader = (sql: SQL) => createContentReader({ sql, onSkip: () => {} });

  test("the token's own slot reads its newest draft", async () => {
    const content = await reader(previewSql()).getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });
    expect(content).toEqual({ heading: "Draft" });
  });

  test("previewing another slot leaves this one published", async () => {
    const content = await reader(previewSql()).getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-2" },
    });
    expect(content).toEqual({ heading: "Published" });
  });

  test("a page token never shows a slot's draft", async () => {
    const content = await reader(previewSql()).getSlot("home.hero", {
      preview: { subjectType: "page", subjectId: "slot-1" },
    });
    expect(content).toEqual({ heading: "Published" });
  });

  test("a preview read bypasses the cache", async () => {
    const sql = previewSql();
    const slots = reader(sql);

    // Warm the published cache.
    expect((await slots.getSlot("home.hero"))?.heading).toBe("Published");

    // The preview read must not be served from it.
    const draft = await slots.getSlot("home.hero", {
      preview: { subjectType: "slot", subjectId: "slot-1" },
    });
    expect(draft).toEqual({ heading: "Draft" });

    // And it must not have written the draft into the published cache.
    expect((await slots.getSlot("home.hero"))?.heading).toBe("Published");
  });

  test("a null preview is the published read", async () => {
    const content = await reader(previewSql()).getSlot("home.hero", {
      preview: null,
    });
    expect(content).toEqual({ heading: "Published" });
  });
});
