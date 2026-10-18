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
 *
 * The version is a `ContentVersion`, shared by every reader on a pool that
 * polls at the same interval. A site mounts the page catch-all and reads slots
 * and media, and all three would otherwise poll `cms_meta` separately: the slot
 * reader, the page reader and the media reader each build a `ContentCache`, and
 * they share one `ContentVersion` so a process asks "has it changed?" once a
 * second rather than once per reader. A reader that tunes the interval shares
 * with the readers that tuned it the same way; only an injected clock gets a
 * private poll. Any reader's `invalidate()` clears the shared poll, so the next
 * read from *any* reader goes back to the database.
 *
 * Two kinds of in-flight work are shared rather than repeated: a version read,
 * so simultaneous misses in one process cost one `cms_meta` query rather than
 * one each, and a load, so simultaneous misses for the same key cost one read
 * rather than one each. The sharing is scoped to the generation in flight, so a
 * load that started before a publish is neither stored nor handed to callers
 * reading on the newer version.
 */
import type { SQL } from "bun";
import { TABLES } from "../contract";
import { defaultSkipLogger, type SkipLogger } from "./log";

/** How often a process re-reads `content_version`. */
export const CONTENT_VERSION_POLL_MS = 1000;

/** Read `cms_meta.content_version` for a pool, or 0 when the row is missing. */
const readContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql.unsafe(
    `SELECT content_version FROM ${TABLES.meta} WHERE id = 1`,
  )) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ContentVersionOptions {
  /** Read `cms_meta.content_version`. */
  readVersion: () => Promise<number>;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often to re-read the version. Defaults to `CONTENT_VERSION_POLL_MS`. */
  intervalMs?: number;
  /**
   * Called when the version check fails but the last version read is still
   * usable. Only a private poll (one built with an injected `now`) routes this
   * to a reader's skip logger; the shared poll reports through the default
   * logger, because it belongs to the pool rather than any one reader.
   */
  onError?: (error: unknown) => void;
}

/**
 * One throttled `content_version` poll, shared by the readers on a pool.
 *
 * The readers each own a `ContentCache` for their own values but not the
 * version: the counter is global, so one poll answering all of them is what
 * keeps a site's steady state at one `cms_meta` query a second rather than one
 * per reader. A failed re-read is not allowed to take away content a reader
 * already has: with a last known version the poll serves it, backs off for one
 * interval and reports the failure; with nothing read yet the error surfaces to
 * the caller, but the same back-off applies so a database that is down when the
 * process first looks isn't hit once per request.
 */
export class ContentVersion {
  readonly #readVersion: () => Promise<number>;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;

  #version: number | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  /**
   * The error from the last failed version read, kept so a process that has
   * never read a version can back off too: with nothing cached there is no
   * value to serve, but the broken database should still not be re-queried on
   * every request. The error is re-thrown until the next interval.
   */
  #error: { error: unknown } | null = null;
  /**
   * Bumped whenever the poll is reset. A read that started under one generation
   * must not store its value after a reset: the value it read is from before
   * whatever the reset was for, and storing it would pretend the poll is fresh.
   */
  #generation = 0;
  /**
   * The read currently in flight, or `null`.
   *
   * A miss after a publish, hit by several requests at once, would otherwise
   * each read `cms_meta`; the first one to arrive starts the read and the rest
   * await it. It is cleared as soon as it settles. The entry carries when it
   * started: a read older than one interval is not joined any more, so a single
   * hung query can't hold every call behind it.
   */
  #pending: { promise: Promise<number>; startedAt: number } | null = null;

  constructor(options: ContentVersionOptions) {
    this.#readVersion = options.readVersion;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? CONTENT_VERSION_POLL_MS;
    this.#onError = options.onError;
  }

  /** The current `content_version`, re-read at most once per interval. */
  async read(): Promise<number> {
    const now = this.#now();
    if (this.#version !== null && now - this.#checkedAt < this.#intervalMs) {
      return this.#version;
    }
    if (
      this.#version === null &&
      this.#error !== null &&
      now - this.#checkedAt < this.#intervalMs
    ) {
      throw this.#error.error;
    }
    // A read already in flight answers this caller too, rather than starting a
    // second one. It is cleared when it settles, so a failure is not cached
    // here — `#readAndStore` decides that. A read that has been in flight
    // longer than one interval is abandoned rather than joined: one hung query
    // must not hold every read in the process behind it.
    const pending = this.#pending;
    if (pending && now - pending.startedAt < this.#intervalMs) {
      return await pending.promise;
    }

    const entry = { promise: this.#readAndStore(now), startedAt: now };
    this.#pending = entry;
    try {
      return await entry.promise;
    } finally {
      if (this.#pending === entry) this.#pending = null;
    }
  }

  /** Read the version and apply it, the work `read()` shares. */
  async #readAndStore(now: number): Promise<number> {
    const generation = this.#generation;
    try {
      const next = await this.#readVersion();
      // A reset while this was in flight means the value is not ours to store:
      // return it, and let the next read re-check rather than pretending the
      // poll is fresh.
      if (generation !== this.#generation) return next;
      this.#version = next;
      this.#checkedAt = now;
      this.#error = null;
      return next;
    } catch (error) {
      // A reset while this read was in flight means the failure is not the
      // reset poll's to remember either.
      if (generation !== this.#generation) throw error;
      this.#checkedAt = now;
      if (this.#version !== null) {
        this.#onError?.(error);
        return this.#version;
      }
      this.#error = { error };
      throw error;
    }
  }

  /**
   * Drop the remembered version and force the next read back to the database.
   *
   * `ContentCache.invalidate()` calls this, so any reader's hard reset also
   * forces the shared poll to re-read, and the other readers see a publish that
   * landed before any of them reached the interval.
   */
  invalidate(): void {
    this.#version = null;
    this.#checkedAt = Number.NEGATIVE_INFINITY;
    this.#error = null;
    this.#pending = null;
    this.#generation += 1;
  }
}

const versionErrorLogger = (error: unknown): void =>
  defaultSkipLogger(
    `could not check the CMS content version: ${describe(error)}`,
  );

/**
 * The version poll for a pool, shared by every reader that polls at the same
 * interval.
 *
 * The poll is keyed by `(pool, intervalMs)`: readers that all use the default
 * interval share one, and a site that tunes `versionPollMs` shares with the
 * readers that tuned it the same way rather than falling back to one poll per
 * reader. Only a reader built with an injected `now` (tests) gets a private
 * poll, because its clock would fight the shared one's.
 *
 * Version-poll failures are reported through the plugin's default logger, once
 * per failed poll, not through any reader's `onSkip`: the shared poll outlives
 * every reader that maps onto it and cannot be routed to one of their sinks.
 * A private poll (injected clock) keeps its own `onError`, so a test can watch
 * the failure directly.
 */
const sharedVersions = new WeakMap<SQL, Map<number, ContentVersion>>();

/**
 * Options for `contentVersionFor`.
 *
 * `onError` exists only on a private poll, the one built with an injected `now`
 * (tests): its clock would fight the shared one's, so it keeps its own failure
 * sink. The shared poll belongs to the pool and reports through the default
 * logger, so it has no `onError` to drop — passing one without a `now` is a
 * type error rather than a silent no-op.
 */
type ContentVersionSourceOptions =
  | {
      now?: undefined;
      intervalMs?: number;
      onError?: never;
    }
  | {
      now: () => number;
      intervalMs?: number;
      onError?: (error: unknown) => void;
    };

export const contentVersionFor = (
  sql: SQL,
  options: ContentVersionSourceOptions = {},
): ContentVersion => {
  if (options.now !== undefined) {
    return new ContentVersion({
      readVersion: () => readContentVersion(sql),
      now: options.now,
      ...(options.intervalMs !== undefined
        ? { intervalMs: options.intervalMs }
        : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  const intervalMs = options.intervalMs ?? CONTENT_VERSION_POLL_MS;
  let byInterval = sharedVersions.get(sql);
  if (!byInterval) {
    byInterval = new Map<number, ContentVersion>();
    sharedVersions.set(sql, byInterval);
  }
  const existing = byInterval.get(intervalMs);
  if (existing) return existing;
  const version = new ContentVersion({
    readVersion: () => readContentVersion(sql),
    intervalMs,
    onError: versionErrorLogger,
  });
  byInterval.set(intervalMs, version);
  return version;
};

/** What a reader spreads into its `ContentCache`: the shared poll and its clock. */
export interface ReaderCacheOptions {
  version: ContentVersion;
  now?: () => number;
  intervalMs?: number;
}

/**
 * The `ContentCache` options a reader builds from its own options.
 *
 * Every reader wants the same three things — the shared version poll, and its
 * own clock and interval so both the poll and the cache's load-sharing window
 * see them — and each used to repeat the same spread and failure message. This
 * is that in one place.
 *
 * `onSkip` receives a version-poll failure only on a private poll (a reader
 * built with an injected `now`); a shared poll reports through the default
 * logger, as `contentVersionFor` documents.
 */
export const readerCacheOptions = (
  sql: SQL,
  options: { now?: () => number; versionPollMs?: number },
  onSkip: SkipLogger,
): ReaderCacheOptions => {
  // A private poll (an injected clock) reports a version failure through this
  // reader's `onSkip`; a shared poll has no `onError` to hand over and reports
  // through the default logger. Build the closure only for the private case, so
  // the option is never a silently dropped no-op on a shared poll.
  const clock = options.now;
  const version = clock
    ? contentVersionFor(sql, {
        now: clock,
        ...(options.versionPollMs !== undefined
          ? { intervalMs: options.versionPollMs }
          : {}),
        onError: (error) => {
          onSkip(`could not check the CMS content version: ${describe(error)}`);
        },
      })
    : contentVersionFor(sql, {
        ...(options.versionPollMs !== undefined
          ? { intervalMs: options.versionPollMs }
          : {}),
      });

  return {
    version,
    ...(clock ? { now: clock } : {}),
    ...(options.versionPollMs !== undefined
      ? { intervalMs: options.versionPollMs }
      : {}),
  };
};

export interface ContentCacheOptions<V> {
  /** Read `cms_meta.content_version`. Omit when a shared `version` is given. */
  readVersion?: () => Promise<number>;
  /** Load the value for one key, when it isn't cached or the version moved. */
  load: (key: string) => Promise<V>;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often to re-read the version. Defaults to `CONTENT_VERSION_POLL_MS`. */
  intervalMs?: number;
  /**
   * Called when the version check fails but the cache can fall back to the last
   * version it read. Used only when the cache builds its own poll from
   * `readVersion` (tests); a cache handed a shared `version` reports through
   * that poll's own sink.
   */
  onVersionError?: (error: unknown) => void;
  /**
   * A shared poll, so several readers on one pool cost one `cms_meta` query.
   * Omit to build a private one from `readVersion`/`now`/`intervalMs`.
   */
  version?: ContentVersion;
}

export class ContentCache<V> {
  readonly #load: (key: string) => Promise<V>;
  readonly #versions: ContentVersion;
  readonly #now: () => number;
  readonly #intervalMs: number;

  #version: number | null = null;
  #entries = new Map<string, V>();
  /**
   * Bumped whenever the version moves or the cache is reset. A `get` that
   * started under one generation must not write its value after the version has
   * changed: the load it awaited may take longer than the interval, and the
   * value it read is from before a publish. Tagging the write is what keeps a
   * slow first read from resurrecting stale content behind a fresher load.
   */
  #generation = 0;
  /**
   * The loads currently in flight, keyed by the cache key.
   *
   * A load that is still running joins a request that arrives for the same key
   * under the same generation, so ten simultaneous misses for one cold slot
   * cost one query. The entry carries the generation it started under: a load
   * from before a publish is not shared with callers reading on the newer
   * version, which start their own instead. It also carries when it started, so
   * a load older than one interval is not joined either — a hung key load must
   * not stall every read for that key forever.
   */
  #loads = new Map<
    string,
    { generation: number; promise: Promise<V>; startedAt: number }
  >();

  constructor(options: ContentCacheOptions<V>) {
    this.#load = options.load;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? CONTENT_VERSION_POLL_MS;
    if (options.version) {
      this.#versions = options.version;
    } else if (options.readVersion) {
      this.#versions = new ContentVersion({
        readVersion: options.readVersion,
        ...(options.now ? { now: options.now } : {}),
        ...(options.intervalMs !== undefined
          ? { intervalMs: options.intervalMs }
          : {}),
        ...(options.onVersionError ? { onError: options.onVersionError } : {}),
      });
    } else {
      throw new TypeError(
        "ContentCache needs a shared `version` or a `readVersion` to poll with",
      );
    }
  }

  /**
   * The current `content_version`.
   *
   * The number comes from the (possibly shared) version poll; this cache only
   * has to notice when it moved and drop its own entries. The version is global,
   * so a single publish can invalidate any cached value.
   */
  async version(): Promise<number> {
    const generation = this.#generation;
    const next = await this.#versions.read();
    // A reset while the read was in flight means the value is not ours to
    // store: the reset stands and the next read re-checks.
    if (generation === this.#generation && next !== this.#version) {
      this.#entries.clear();
      this.#loads.clear();
      this.#version = next;
      this.#generation += 1;
    }
    return next;
  }

  /** The cached value for `key`, loading and caching it when absent or stale. */
  async get(key: string): Promise<V> {
    await this.version();
    if (this.#entries.has(key)) return this.#entries.get(key) as V;

    const generation = this.#generation;
    // A load for the same key, started on this generation and still fresh,
    // answers too: ten simultaneous first reads of one slot cost one query, not
    // ten. A load older than one interval is left to finish on its own rather
    // than joined, so a hung key load can't stall every read for that key.
    const now = this.#now();
    const pending = this.#loads.get(key);
    if (
      pending &&
      pending.generation === generation &&
      now - pending.startedAt < this.#intervalMs
    ) {
      return await pending.promise;
    }

    const promise = (async () => this.#load(key))();
    this.#loads.set(key, { generation, promise, startedAt: now });
    try {
      const value = await promise;
      // The version may have moved while the load was in flight. The value the
      // caller gets is still the one it asked for, but caching it would leave
      // the cache holding pre-publish content under the new version.
      if (this.#generation === generation) {
        this.#entries.set(key, value);
      }
      return value;
    } finally {
      // A rejected load is removed here too, so the next read starts a fresh
      // one rather than joining a promise that has already failed.
      const current = this.#loads.get(key);
      if (current?.promise === promise) this.#loads.delete(key);
    }
  }

  /**
   * Drop every cached entry and force the next read to re-check the version.
   *
   * A hard reset, as the readers document it: the entries, any load in flight
   * and any remembered failure go, and `content_version` is re-read by the next
   * read even when the interval has not passed. The generation moves too, so a
   * load that started before the reset cannot write its value back. The shared
   * poll is reset as well, so a publish that landed is seen at once.
   */
  invalidate(): void {
    this.#entries.clear();
    this.#loads.clear();
    this.#version = null;
    this.#generation += 1;
    this.#versions.invalidate();
  }
}
