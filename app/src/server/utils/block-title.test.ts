import { describe, expect, test } from "bun:test";
import { blockLabel } from "./block-title";

describe("blockLabel", () => {
  test("uses the published label when there is one", () => {
    expect(blockLabel({ label: "Pull quote", name: "quote" })).toBe(
      "Pull quote",
    );
  });

  test("humanises a name with separators when the label is empty", () => {
    expect(blockLabel({ label: "", name: "photo_wall" })).toBe("Photo wall");
  });

  // Migration 021 leaves old rows blank, and a site can name a block in
  // camelCase. The fallback must read as words, not "FullImage".
  test("splits a camelCase name into words when the label is empty", () => {
    expect(blockLabel({ label: "", name: "fullImage" })).toBe("Full image");
  });
});
