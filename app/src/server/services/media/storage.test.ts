import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskStorage } from "@alexpricedev/billet-storage";
import {
  getMediaStorage,
  mediaStorageConfigFromEnv,
  resetMediaStorageForTest,
} from "./storage";

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

  test("reads MEDIA_PUBLIC_BASE_URL, never the package's own variable", () => {
    expect(
      mediaStorageConfigFromEnv({
        ...base,
        STORAGE_PUBLIC_BASE_URL: "https://elsewhere.example",
      })?.publicBaseUrl,
    ).toBe("https://media.example");
    expect(
      mediaStorageConfigFromEnv({
        ...base,
        MEDIA_PUBLIC_BASE_URL: undefined,
        STORAGE_PUBLIC_BASE_URL: "https://elsewhere.example",
      }),
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

describe("local media storage (the package's disk driver)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cms-media-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => resetMediaStorageForTest());
  afterEach(() => resetMediaStorageForTest());

  test("puts, serves a public URL for, and deletes an object", async () => {
    const storage = createDiskStorage({
      dir,
      publicBaseUrl: "http://localhost:3001/media",
    });
    await storage.put(
      "media/a/1.webp",
      new Uint8Array([1, 2, 3]),
      "image/webp",
    );

    expect(existsSync(join(dir, "media/a/1.webp"))).toBe(true);
    expect(storage.publicUrl("media/a/1.webp")).toBe(
      "http://localhost:3001/media/media/a/1.webp",
    );

    await storage.delete("media/a/1.webp");
    expect(existsSync(join(dir, "media/a/1.webp"))).toBe(false);
    // Missing keys are not an error.
    await storage.delete("media/a/1.webp");
  });

  test("refuses a key that leaves the directory", async () => {
    const storage = createDiskStorage({
      dir,
      publicBaseUrl: "http://localhost:3001/media",
    });
    await expect(
      storage.put("../escape.txt", new Uint8Array([1]), "text/plain"),
    ).rejects.toThrow("Invalid storage key");
    await expect(storage.delete("a/../../escape.txt")).rejects.toThrow(
      "Invalid storage key",
    );
  });

  test("getMediaStorage uses it outside production, ahead of S3", () => {
    const env = {
      ...base,
      MEDIA_LOCAL_DIR: dir,
      MEDIA_PUBLIC_BASE_URL: "http://localhost:3001/media",
      NODE_ENV: "development",
    };
    expect(getMediaStorage(env)?.publicUrl("k")).toBe(
      "http://localhost:3001/media/k",
    );
  });

  test("ignores MEDIA_LOCAL_DIR in production", () => {
    const env = {
      MEDIA_LOCAL_DIR: dir,
      MEDIA_PUBLIC_BASE_URL: "http://localhost:3001/media",
      NODE_ENV: "production",
    };
    expect(getMediaStorage(env)).toBeNull();
  });
});
