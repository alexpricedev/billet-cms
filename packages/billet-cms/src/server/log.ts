/* biome-ignore-all lint/suspicious/noConsole: the plugin's fallback logger */

/**
 * Where a read helper reports content it skipped.
 *
 * A site's page must keep rendering when a slot's stored content no longer
 * validates, the block behind it was removed, or the CMS's tables aren't there
 * at all: the helper logs what it dropped and returns nothing rather than
 * letting a bad row 500 the page. The default writes to the console; a site can
 * pass its own sink.
 */
export type SkipLogger = (message: string) => void;

/** How long `throttleSkips` swallows a message it has already reported. */
export const DEFAULT_SKIP_THROTTLE_MS = 60_000;

/**
 * The most distinct messages a throttle remembers.
 *
 * The key is the message, and a message can carry a database error, so the set
 * is not bounded by the site's own slot count the way it first looks. The cap
 * keeps a long-running process from accumulating one entry per distinct
 * failure string; past it the oldest entry is dropped, which at worst lets a
 * message through early.
 */
const MAX_TRACKED_MESSAGES = 256;

export interface ThrottleSkipsOptions {
  /** Defaults to `DEFAULT_SKIP_THROTTLE_MS`. */
  windowMs?: number;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Report each distinct message at most once per window.
 *
 * Every skip is per subject per read, so a site whose CMS is not set up yet
 * reports one line per slot on *every* request — five slots on a landing page
 * is five identical lines a hit, for as long as the tables are missing. That is
 * the state a site ships in between deploying the plugin and deploying the CMS,
 * and it is the state its tests run in, so the noise is the normal case rather
 * than an incident.
 *
 * The cost is not the volume, it is what the volume hides: the one line that
 * matters later — a single slot whose stored content stopped validating — looks
 * exactly like the thousands around it. Throttling by message keeps every
 * distinct problem visible and drops only the repeats.
 *
 * Deliberately a wrapper rather than something the readers do for themselves. A
 * site feeding a structured log that already samples should not have a second
 * throttle underneath it, and a site that genuinely wants every line should be
 * able to have one.
 */
export const throttleSkips = (
  log: SkipLogger,
  options: ThrottleSkipsOptions = {},
): SkipLogger => {
  const windowMs = options.windowMs ?? DEFAULT_SKIP_THROTTLE_MS;
  const now = options.now ?? Date.now;
  const lastLoggedAt = new Map<string, number>();

  return (message) => {
    const at = now();
    const previous = lastLoggedAt.get(message);
    if (previous !== undefined && at - previous < windowMs) return;

    // Re-inserting moves the key to the end of the Map's insertion order, so
    // the first key is always the least recently reported one.
    lastLoggedAt.delete(message);
    lastLoggedAt.set(message, at);
    if (lastLoggedAt.size > MAX_TRACKED_MESSAGES) {
      const oldest = lastLoggedAt.keys().next();
      if (!oldest.done) lastLoggedAt.delete(oldest.value);
    }

    log(message);
  };
};

/**
 * The console sink, throttled.
 *
 * Throttled rather than raw because this is what a site gets without asking,
 * and an unthrottled default is what fills a log with one line per slot per
 * request before the CMS exists. A site passing its own `onSkip` opts out and
 * can wrap it in `throttleSkips` to opt back in.
 */
export const defaultSkipLogger: SkipLogger = throttleSkips((message) => {
  console.warn(`[billet-cms] ${message}`);
});
