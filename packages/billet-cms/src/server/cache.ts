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
}

export class ContentCache<V> {
  readonly #readVersion: () => Promise<number>;
  readonly #load: (key: string) => Promise<V>;
  readonly #now: () => number;
  readonly #intervalMs: number;

  #version: number | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #entries = new Map<string, V>();

  constructor(options: ContentCacheOptions<V>) {
    this.#readVersion = options.readVersion;
    this.#load = options.load;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? CONTENT_VERSION_POLL_MS;
  }

  /**
   * The current `content_version`, re-read at most once per interval.
   *
   * When the number changes the whole cache is dropped: the version is global,
   * so a single publish can invalidate any cached slot, not just the one that
   * changed. A no-op re-read keeps the cache warm, which is what makes the
   * steady state free.
   */
  async version(): Promise<number> {
    const now = this.#now();
    if (this.#version !== null && now - this.#checkedAt < this.#intervalMs) {
      return this.#version;
    }

    const next = await this.#readVersion();
    if (next !== this.#version) {
      this.#entries.clear();
      this.#version = next;
    }
    this.#checkedAt = now;
    return this.#version;
  }

  /** The cached value for `key`, loading and caching it when absent or stale. */
  async get(key: string): Promise<V> {
    await this.version();
    if (this.#entries.has(key)) return this.#entries.get(key) as V;

    const value = await this.#load(key);
    this.#entries.set(key, value);
    return value;
  }

  /** Forget when the version was last checked, forcing the next `get` to re-read it. */
  invalidate(): void {
    this.#checkedAt = Number.NEGATIVE_INFINITY;
  }
}
