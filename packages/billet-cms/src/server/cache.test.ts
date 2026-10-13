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

  // A failed version check must not cost the process content it already has.
  test("serves the last version when the check fails, and backs off", async () => {
    const state = { now: 0, version: 1, reads: 0, fails: false };
    const errors: unknown[] = [];
    const cache = new ContentCache<string>({
      readVersion: async () => {
        state.reads += 1;
        if (state.fails) throw new Error("cms_meta is gone");
        return state.version;
      },
      load: async (key) => `${state.version}:${key}`,
      now: () => state.now,
      intervalMs: 1000,
      onVersionError: (error) => errors.push(error),
    });

    expect(await cache.get("a")).toBe("1:a");

    // The CMS goes away between reads.
    state.fails = true;
    state.now = 1000;
    expect(await cache.get("a")).toBe("1:a");
    expect(errors).toHaveLength(1);

    // Backed off for one interval.
    state.now = 1100;
    expect(await cache.get("a")).toBe("1:a");
    expect(state.reads).toBe(2);

    // Recovered: the version moves and the cache drops.
    state.fails = false;
    state.version = 2;
    state.now = 2000;
    expect(await cache.get("a")).toBe("2:a");
    expect(state.reads).toBe(3);
  });

  test("backs off when the check fails before any version was read", async () => {
    const state = { now: 0, reads: 0 };
    const cache = new ContentCache<string>({
      readVersion: async () => {
        state.reads += 1;
        throw new Error("cms_meta is gone");
      },
      load: async (key) => key,
      now: () => state.now,
      intervalMs: 1000,
    });

    await expect(cache.version()).rejects.toThrow("cms_meta is gone");
    expect(state.reads).toBe(1);

    // Inside the interval, the stored error is re-thrown without re-querying.
    state.now = 100;
    await expect(cache.version()).rejects.toThrow("cms_meta is gone");
    expect(state.reads).toBe(1);

    // Past the interval, it tries again.
    state.now = 1000;
    await expect(cache.version()).rejects.toThrow("cms_meta is gone");
    expect(state.reads).toBe(2);
  });

  // A load can outlive the interval it started in. If it were cached anyway it
  // would take the place of fresher content, so the write is tagged with the
  // generation it started under and dropped once the version has moved.
  test("does not cache a load that started before the version moved", async () => {
    const state = { now: 0, version: 1, versionReads: 0, loads: 0 };
    let releaseLoad: (value: string) => void = () => {};
    const loadStarted = Promise.withResolvers<void>();
    const cache = new ContentCache<string>({
      readVersion: async () => {
        state.versionReads += 1;
        return state.version;
      },
      load: (key) => {
        state.loads += 1;
        const versionWhenLoaded = state.version;
        // The first read parks until the test releases it; later reads resolve
        // straight away so the test can assert what the cache does next.
        if (state.loads > 1) {
          return Promise.resolve(`${versionWhenLoaded}:${key}:fresh`);
        }
        loadStarted.resolve();
        return new Promise<string>((resolve) => {
          releaseLoad = (value) =>
            resolve(`${versionWhenLoaded}:${key}:${value}`);
        });
      },
      now: () => state.now,
      intervalMs: 1000,
    });

    // Start a read under version 1 and let it park inside `load`.
    const pending = cache.get("home.hero");
    await loadStarted.promise;

    // A publish moves the version while the load is still in flight.
    state.version = 2;
    state.now = 1000;
    await cache.version();

    releaseLoad("stale");
    // The caller still gets the value it read...
    expect(await pending).toBe("1:home.hero:stale");

    // ...but it was not cached: the next read loads afresh under version 2.
    state.now = 1500;
    expect(await cache.get("home.hero")).toBe("2:home.hero:fresh");
    expect(state.loads).toBe(2);
  });
});
