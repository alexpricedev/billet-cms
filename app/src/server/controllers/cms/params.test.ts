import { describe, expect, test } from "bun:test";
import { MAX_CONTENT_BYTES, nonEmpty, parseJsonObject } from "./params";

describe("nonEmpty", () => {
  test("keeps a non-empty string and drops everything else", () => {
    expect(nonEmpty("x")).toBe("x");
    expect(nonEmpty("")).toBeNull();
    expect(nonEmpty(null)).toBeNull();
    // A File part is not a string, so it is not a value here.
    expect(nonEmpty(new File([], "x.png"))).toBeNull();
  });
});

describe("parseJsonObject", () => {
  test("parses a JSON object and rejects anything else", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toBeNull();
    expect(parseJsonObject('"text"')).toBeNull();
    expect(parseJsonObject("not json")).toBeNull();
    expect(parseJsonObject(null)).toBeNull();
    expect(parseJsonObject("")).toBeNull();
  });

  test("refuses a document over the byte cap instead of parsing it", () => {
    // The whole block/page document rides in one hidden field; a post over the
    // cap is treated as unreadable rather than allocated and parsed.
    const over = JSON.stringify({ text: "x".repeat(MAX_CONTENT_BYTES) });
    expect(Buffer.byteLength(over, "utf8")).toBeGreaterThan(MAX_CONTENT_BYTES);
    expect(parseJsonObject(over)).toBeNull();

    const under = JSON.stringify({ text: "x".repeat(MAX_CONTENT_BYTES - 64) });
    expect(Buffer.byteLength(under, "utf8")).toBeLessThanOrEqual(
      MAX_CONTENT_BYTES,
    );
    expect(parseJsonObject(under)).not.toBeNull();
  });
});
