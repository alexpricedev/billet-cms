/**
 * The site's in-memory content cache, keyed on `cms_meta.content_version` (Q3).
 *
 * The CMS bumps `content_version` whenever published content changes, so a
 * site's process only has to ask "has it changed?" to know whether its cached
 * reads are stale. Reading that counter on every request would put a database
 * round trip on the page's critical path for no benefit, so it is re-read at
 * most once per interval — a second by default — and the cached content is
 * thrown away only when the number actually moves. A publish therefore shows on
 * the site within about a second, without a TTL that could serve stale pages
 * for minutes or a publish-time webhook the two services would have to share.
 *
 * Only the version check is throttled. A cache miss (the first read of a slot
 * after a publish) goes straight to the database, so a fresh visitor never
 * waits longer than the interval for content they don't have cached.
 */

/** How often a process re-reads `content_version`. */
export const CONTENT_VERSION_POLL_MS = 1000;

export interface ContentCacheOptions<V> {
  /** Read `cms_meta.content_version`. */
  readVersion: () => Promise<number>;
  /** Load the value for one key, when it isn't cached or the version moved. */
  load: (key: string) => Promise<V>;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often to re-read the version. Defaults to `CONTENT_VERSION_POLL_MS`. */
  intervalMs?: number;
  /**
   * Called when the version check fails but the cache can fall back to the last
   * version it read. The site's reader wires this to its skip logger.
   */
  onVersionError?: (error: unknown) => void;
}

export class ContentCache<V> {
  readonly #readVersion: () => Promise<number>;
  readonly #load: (key: string) => Promise<V>;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #onVersionError: ((error: unknown) => void) | undefined;

  #version: number | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #entries = new Map<string, V>();
  /**
   * The error from the last failed version read, kept so a process that has
   * never read a version can back off too: with nothing cached there is no
   * value to serve, but the broken database should still not be re-queried on
   * every request. The error is re-thrown until the next interval.
   */
  #versionError: { error: unknown } | null = null;
  /**
   * Bumped whenever the version moves. A `get` that started under one
   * generation must not write its value after the version has changed: the
   * load it awaited may take longer than the interval, and the value it read is
   * from before a publish. Tagging the write is what keeps a slow first read
   * from resurrecting stale content behind a fresher load.
   */
  #generation = 0;

  constructor(options: ContentCacheOptions<V>) {
    this.#readVersion = options.readVersion;
    this.#load = options.load;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? CONTENT_VERSION_POLL_MS;
    this.#onVersionError = options.onVersionError;
  }

  /**
   * The current `content_version`, re-read at most once per interval.
   *
   * When the number changes the whole cache is dropped: the version is global,
   * so a single publish can invalidate any cached slot, not just the one that
   * changed. A no-op re-read keeps the cache warm, which is what makes the
   * steady state free.
   *
   * A failed re-read is not allowed to take away content the process already
   * has. The counter lives in the same database a public page reads from, so
   * "could not read `cms_meta`" is a transient condition — the CMS is down, or
   * mid-migration — and the site must keep rendering. When there is a last
   * known version the cache keeps serving it, backs off for one interval so a
   * broken database isn't re-queried on every request, and reports the failure.
   * With nothing read yet there is nothing cached to serve either, so the error
   * surfaces to the caller — but the same back-off applies, so a database that
   * is down when the process first looks isn't hit once per request either.
   */
  async version(): Promise<number> {
    const now = this.#now();
    if (this.#version !== null && now - this.#checkedAt < this.#intervalMs) {
      return this.#version;
    }
    if (
      this.#version === null &&
      this.#versionError !== null &&
      now - this.#checkedAt < this.#intervalMs
    ) {
      throw this.#versionError.error;
    }

    try {
      const next = await this.#readVersion();
      if (next !== this.#version) {
        this.#entries.clear();
        this.#version = next;
        this.#generation += 1;
      }
      this.#checkedAt = now;
      this.#versionError = null;
      return this.#version;
    } catch (error) {
      this.#checkedAt = now;
      if (this.#version !== null) {
        this.#onVersionError?.(error);
        return this.#version;
      }
      this.#versionError = { error };
      throw error;
    }
  }

  /** The cached value for `key`, loading and caching it when absent or stale. */
  async get(key: string): Promise<V> {
    await this.version();
    if (this.#entries.has(key)) return this.#entries.get(key) as V;

    const generation = this.#generation;
    const value = await this.#load(key);
    // The version may have moved while the load was in flight. The value the
    // caller gets is still the one it asked for, but caching it would leave the
    // cache holding pre-publish content under the new version.
    if (this.#generation === generation) {
      this.#entries.set(key, value);
    }
    return value;
  }

  /** Forget when the version was last checked, forcing the next `get` to re-read it. */
  invalidate(): void {
    this.#checkedAt = Number.NEGATIVE_INFINITY;
  }
}
