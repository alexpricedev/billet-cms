import { describe, expect, test } from "bun:test";
import { formatWhen } from "./format";

describe("formatWhen", () => {
  test("names the instant in UTC", () => {
    const shown = formatWhen(new Date("2026-10-14T15:25:00Z"));
    expect(shown).toContain("2026");
    expect(shown).toContain("15:25");
    // No stray zone name or offset: callers append " UTC" themselves.
    expect(shown).not.toContain("GMT");
    expect(shown).not.toContain("+0");
  });

  test("does not shift with the process timezone", () => {
    const instant = new Date("2026-01-02T03:04:00Z");
    const expected = formatWhen(instant);
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(formatWhen(instant)).toBe(expected);
      process.env.TZ = "Asia/Tokyo";
      expect(formatWhen(instant)).toBe(expected);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
