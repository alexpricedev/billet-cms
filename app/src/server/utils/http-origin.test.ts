import { describe, expect, test } from "bun:test";
import { httpOrigin, httpUrl } from "./http-origin";

describe("httpUrl", () => {
  test("parses an http(s) URL, keeping its path", () => {
    expect(httpUrl("https://example.com/x?y=1")?.href).toBe(
      "https://example.com/x?y=1",
    );
    expect(httpUrl("  http://localhost:4000/media/  ")?.href).toBe(
      "http://localhost:4000/media/",
    );
  });

  test("is null for blank, missing and unparseable values", () => {
    expect(httpUrl(undefined)).toBeNull();
    expect(httpUrl(null)).toBeNull();
    expect(httpUrl("")).toBeNull();
    expect(httpUrl("   ")).toBeNull();
    expect(httpUrl("not a url")).toBeNull();
    expect(httpUrl("/relative")).toBeNull();
  });

  test("is null for a scheme that isn't http(s)", () => {
    expect(httpUrl("ftp://bucket.example/media")).toBeNull();
    expect(httpUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(httpUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("httpOrigin", () => {
  test("returns the origin of an http(s) URL, dropping any path", () => {
    expect(httpOrigin("https://example.com/x?y=1")).toBe("https://example.com");
    expect(httpOrigin("  http://localhost:4000/  ")).toBe(
      "http://localhost:4000",
    );
    expect(httpOrigin("https://bucket.example.com/media")).toBe(
      "https://bucket.example.com",
    );
  });

  test("is null for blank, missing and unparseable values", () => {
    expect(httpOrigin(undefined)).toBeNull();
    expect(httpOrigin(null)).toBeNull();
    expect(httpOrigin("")).toBeNull();
    expect(httpOrigin("   ")).toBeNull();
    expect(httpOrigin("not a url")).toBeNull();
    expect(httpOrigin("/relative")).toBeNull();
  });

  // `new URL` parses these happily: `ftp:` has a real origin string, and
  // `data:`/`javascript:` report the literal "null". None is an origin a page
  // can load, so none may reach a CSP source list or a preview link.
  test("is null for a scheme that isn't http(s)", () => {
    expect(httpOrigin("ftp://bucket.example/media")).toBeNull();
    expect(httpOrigin("data:image/png;base64,AAAA")).toBeNull();
    expect(httpOrigin("javascript:alert(1)")).toBeNull();
    expect(httpOrigin("mailto:security@example.com")).toBeNull();
    expect(httpOrigin("file:///etc/hosts")).toBeNull();
  });
});
