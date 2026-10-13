import { describe, expect, test } from "bun:test";
import { CONTENT_VERSION_POLL_MS, ContentCache } from "./cache";

/** A cache over a counter the test controls, with an injectable clock. */
const makeCache = () => {
  const state = { now: 0, version: 1, versionReads: 0, loads: 0 };
  const cache = new ContentCache<string>({
    readVersion: async () => {
      state.versionReads += 1;
      return state.version;
    },
    load: async (key) => {
      state.loads += 1;
      return `${state.version}:${key}`;
    },
    now: () => state.now,
    intervalMs: 1000,
  });
  return { state, cache };
};

describe("CONTENT_VERSION_POLL_MS", () => {
  test("is the once-a-second check Q3 settled on", () => {
    expect(CONTENT_VERSION_POLL_MS).toBe(1000);
  });
});

describe("ContentCache", () => {
  test("re-reads the content version at most once per interval (Q3)", async () => {
    const { state, cache } = makeCache();

    expect(await cache.get("home.hero")).toBe("1:home.hero");
    expect(state.versionReads).toBe(1);
    expect(state.loads).toBe(1);

    // Within the window: cached, with no version read and no load.
    state.now = 500;
    expect(await cache.get("home.hero")).toBe("1:home.hero");
    expect(state.versionReads).toBe(1);
    expect(state.loads).toBe(1);

    // A different key within the window loads itself but shares the version
    // check: the window is per process, not per key.
    expect(await cache.get("home.footer")).toBe("1:home.footer");
    expect(state.versionReads).toBe(1);
    expect(state.loads).toBe(2);

    // At the boundary the version is read again; unchanged, so the cache stays
    // warm and nothing reloads.
    state.now = 1000;
    expect(await cache.get("home.hero")).toBe("1:home.hero");
    expect(state.versionReads).toBe(2);
    expect(state.loads).toBe(2);
  });

  test("drops cached content when the version moves", async () => {
    const { state, cache } = makeCache();

    expect(await cache.get("home.hero")).toBe("1:home.hero");

    state.version = 2;
    state.now = 1000;
    expect(await cache.get("home.hero")).toBe("2:home.hero");
    expect(state.loads).toBe(2);
  });

  test("invalidate forces the next read to re-check the version", async () => {
    const { state, cache } = makeCache();

    await cache.get("home.hero");
    expect(state.versionReads).toBe(1);

    cache.invalidate();
    // Still inside the interval, but the check was forced.
    await cache.get("home.hero");
    expect(state.versionReads).toBe(2);
  });
});
