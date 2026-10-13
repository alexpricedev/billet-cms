import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createContentReader } from "./slots";

/** A pool whose first query throws, standing in for a CMS that isn't reachable. */
const throwingSql = {
  unsafe: () => {
    throw new Error('relation "cms_meta" does not exist');
  },
} as unknown as SQL;

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
});
