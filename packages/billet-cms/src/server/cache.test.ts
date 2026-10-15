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

  // The doc says a hard reset, so an invalidate must drop the entries even when
  // `content_version` has not moved; otherwise `invalidate()` would only force
  // the version check and keep serving the same values.
  test("invalidate drops every entry when the version has not changed", async () => {
    const { state, cache } = makeCache();

    expect(await cache.get("home.hero")).toBe("1:home.hero");
    expect(state.loads).toBe(1);

    cache.invalidate();
    expect(await cache.get("home.hero")).toBe("1:home.hero");
    expect(state.versionReads).toBe(2);
    expect(state.loads).toBe(2);
  });

  // The reset must not be overwritten by a version read that was already in
  // flight: the next read re-checks rather than treating the old value as fresh.
  test("does not store a version read that was in flight across invalidate", async () => {
    const state = { reads: 0 };
    let release!: (value: number) => void;
    const started = Promise.withResolvers<void>();
    const cache = new ContentCache<string>({
      readVersion: () => {
        state.reads += 1;
        if (state.reads === 1) {
          started.resolve();
          return new Promise<number>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(99);
      },
      load: async (key) => key,
      now: () => 0,
      intervalMs: 1000,
    });

    const pending = cache.version();
    await started.promise;
    cache.invalidate();
    release(1);

    // The in-flight caller still gets what it read...
    expect(await pending).toBe(1);
    // ...but the reset stands: the next read goes back to the source.
    expect(await cache.version()).toBe(99);
    expect(state.reads).toBe(2);
  });

  // A miss after a publish, hit by several requests at once, must cost one
  // version read and one load, not one of each per request.
  test("shares one version read and one load between simultaneous misses", async () => {
    const state = { versionReads: 0, loads: 0 };
    let release!: (value: string) => void;
    const loadStarted = Promise.withResolvers<void>();
    const cache = new ContentCache<string>({
      readVersion: async () => {
        state.versionReads += 1;
        return 1;
      },
      load: (key) => {
        state.loads += 1;
        loadStarted.resolve();
        return new Promise<string>((resolve) => {
          release = (value) => resolve(`${key}:${value}`);
        });
      },
      now: () => 0,
      intervalMs: 1000,
    });

    const pending = Array.from({ length: 10 }, () => cache.get("home.hero"));
    await loadStarted.promise;
    release("value");

    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 10 }, () => "home.hero:value"),
    );
    expect(state.versionReads).toBe(1);
    expect(state.loads).toBe(1);
  });

  // A load that fails is not cached: the next read starts a fresh one rather
  // than joining a promise that has already rejected.
  test("does not cache a rejected load, and reloads on the next read", async () => {
    const state = { loads: 0 };
    const cache = new ContentCache<string>({
      readVersion: async () => 1,
      load: async (key) => {
        state.loads += 1;
        if (state.loads === 1) throw new Error("the database is down");
        return key;
      },
      now: () => 0,
      intervalMs: 1000,
    });

    await expect(cache.get("home.hero")).rejects.toThrow(
      "the database is down",
    );
    expect(await cache.get("home.hero")).toBe("home.hero");
    expect(state.loads).toBe(2);
  });

  test("shares one failing load between simultaneous misses, then clears it", async () => {
    const state = { loads: 0 };
    let reject!: (error: unknown) => void;
    const started = Promise.withResolvers<void>();
    const cache = new ContentCache<string>({
      readVersion: async () => 1,
      load: () => {
        state.loads += 1;
        started.resolve();
        return new Promise<string>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        });
      },
      now: () => 0,
      intervalMs: 1000,
    });

    // Convert to settled results so both rejections are handled from the start.
    const settle = (promise: Promise<string>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const pending = [
      settle(cache.get("home.hero")),
      settle(cache.get("home.hero")),
    ];
    await started.promise;
    reject(new Error("the database is down"));

    const [first, second] = await Promise.all(pending);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok)
      expect(String(first.error)).toContain("the database is down");
    if (!second.ok) {
      expect(String(second.error)).toContain("the database is down");
    }
    expect(state.loads).toBe(1);
  });

  // A load that started before a publish must not be handed to a caller reading
  // on the newer version: it would show pre-publish content the new version
  // already invalidated.
  test("does not share an old-generation load with a new-generation caller", async () => {
    const state = { now: 0, version: 1, loads: 0 };
    let release!: (value: string) => void;
    const loadStarted = Promise.withResolvers<void>();
    const cache = new ContentCache<string>({
      readVersion: async () => state.version,
      load: (key) => {
        state.loads += 1;
        if (state.loads === 1) {
          loadStarted.resolve();
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(`fresh:${key}`);
      },
      now: () => state.now,
      intervalMs: 1000,
    });

    const stale = cache.get("home.hero");
    await loadStarted.promise;

    // A publish moves the version while the load is still in flight.
    state.version = 2;
    state.now = 1000;
    await cache.version();

    const fresh = cache.get("home.hero");
    release("stale");

    expect(await stale).toBe("stale");
    expect(await fresh).toBe("fresh:home.hero");
    expect(state.loads).toBe(2);
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
