import { describe, expect, test } from "bun:test";
import {
  contentParseMessage,
  MAX_CONTENT_BYTES,
  nonEmpty,
  parseContent,
} from "./params";

describe("nonEmpty", () => {
  test("keeps a non-empty string and drops everything else", () => {
    expect(nonEmpty("x")).toBe("x");
    expect(nonEmpty("")).toBeNull();
    expect(nonEmpty(null)).toBeNull();
    // A File part is not a string, so it is not a value here.
    expect(nonEmpty(new File([], "x.png"))).toBeNull();
  });
});

describe("parseContent", () => {
  test("parses a JSON object and rejects anything else", () => {
    expect(parseContent('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseContent("[1,2]")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseContent('"text"')).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(parseContent("not json")).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(parseContent(null)).toEqual({ ok: false, reason: "unreadable" });
    expect(parseContent("")).toEqual({ ok: false, reason: "unreadable" });
  });

  test("marks a document over the byte cap as too large, not unreadable", () => {
    // The whole block/page document rides in one hidden field; a post over the
    // cap is refused before it is parsed, and says so.
    const over = JSON.stringify({ text: "x".repeat(MAX_CONTENT_BYTES) });
    expect(Buffer.byteLength(over, "utf8")).toBeGreaterThan(MAX_CONTENT_BYTES);
    expect(parseContent(over)).toEqual({ ok: false, reason: "too-large" });

    const under = JSON.stringify({ text: "x".repeat(MAX_CONTENT_BYTES - 64) });
    expect(Buffer.byteLength(under, "utf8")).toBeLessThanOrEqual(
      MAX_CONTENT_BYTES,
    );
    expect(parseContent(under).ok).toBe(true);
  });

  test("gives the too-large case its own message", () => {
    expect(contentParseMessage("unreadable")).toContain("could not be read");
    expect(contentParseMessage("too-large")).toContain("too large to save");
  });
});
