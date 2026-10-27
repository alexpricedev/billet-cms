import { describe, expect, test } from "bun:test";
import { formatDay, formatWhen } from "./format";

describe("formatWhen", () => {
  // Pinned, separator included. `toLocaleString({ dateStyle, timeStyle })`
  // lets ICU choose what joins the date and the time, and it changed: newer
  // data gives en-GB "11 Jan 2026 at 09:00". Two callers introduce this value
  // with their own "at" ("…, at {formatWhen(…)} UTC."), so that spelling ships
  // a doubled "at" to an editor, and the only thing that caught it was a
  // template test somewhere else.
  test("joins the date and the time with a comma", () => {
    expect(formatWhen(new Date("2026-01-11T09:00:00Z"))).toBe(
      "11 Jan 2026, 09:00",
    );
  });

  test("uses the same date as formatDay", () => {
    const instant = new Date("2026-10-14T15:25:00Z");

    expect(formatWhen(instant).startsWith(`${formatDay(instant)}, `)).toBe(
      true,
    );
  });

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
