import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaStorageConfigFromEnv, resetMediaStorageForTest } from "./storage";

const base: Record<string, string | undefined> = {
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  MEDIA_PUBLIC_BASE_URL: "https://media.example",
};

describe("mediaStorageConfigFromEnv", () => {
  test("reads the required bucket settings", () => {
    const config = mediaStorageConfigFromEnv(base);

    expect(config?.bucket).toBe("bucket");
    expect(config?.publicBaseUrl).toBe("https://media.example");
  });

  test("refuses a public base URL that isn't an absolute http(s) URL", () => {
    // It becomes every stored rendition's public URL — rendered into pages and
    // CSP `img-src` — so a non-http(s) or relative value is treated as unset.
    for (const value of [
      "ftp://bucket.example",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "not a url",
      "",
      "   ",
    ]) {
      expect(
        mediaStorageConfigFromEnv({ ...base, MEDIA_PUBLIC_BASE_URL: value }),
      ).toBeNull();
    }

    // Plain http is still accepted outside production (a local or staging
    // bucket); the scheme is the check here, not TLS.
    expect(
      mediaStorageConfigFromEnv({
        ...base,
        MEDIA_PUBLIC_BASE_URL: "http://localhost:9000/media",
      }),
    ).not.toBeNull();
  });

  test("returns null when any required setting is missing", () => {
    expect(mediaStorageConfigFromEnv({ ...base, S3_BUCKET: "" })).toBeNull();
    expect(
      mediaStorageConfigFromEnv({ ...base, S3_ACCESS_KEY_ID: "  " }),
    ).toBeNull();
    expect(
      mediaStorageConfigFromEnv({ ...base, S3_SECRET_ACCESS_KEY: undefined }),
    ).toBeNull();
  });
});

// r1-19: a public base URL that is set but rejected turns every upload into a
// refusal, so it is reported once rather than silently.
describe("rejected MEDIA_PUBLIC_BASE_URL", () => {
  const warnings: string[] = [];
  let restoreWarn: () => void;

  beforeEach(() => {
    resetMediaStorageForTest();
    warnings.length = 0;
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    restoreWarn = () => {
      console.warn = original;
    };
  });

  afterEach(() => {
    restoreWarn();
    resetMediaStorageForTest();
  });

  test("warns once when the value is set but not an http(s) URL", () => {
    expect(
      mediaStorageConfigFromEnv({
        ...base,
        MEDIA_PUBLIC_BASE_URL: "ftp://bucket.example",
      }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MEDIA_PUBLIC_BASE_URL");
    expect(warnings[0]).toContain("not an absolute http(s) URL");

    // Later reads of a bad value do not repeat it.
    mediaStorageConfigFromEnv({
      ...base,
      MEDIA_PUBLIC_BASE_URL: "ftp://bucket.example",
    });
    mediaStorageConfigFromEnv({
      ...base,
      MEDIA_PUBLIC_BASE_URL: "not a url",
    });
    expect(warnings).toHaveLength(1);
  });

  test("says nothing when the value is missing or valid", () => {
    expect(mediaStorageConfigFromEnv({ ...base })).not.toBeNull();
    expect(
      mediaStorageConfigFromEnv({ ...base, MEDIA_PUBLIC_BASE_URL: "" }),
    ).toBeNull();
    expect(warnings).toEqual([]);
  });
});
