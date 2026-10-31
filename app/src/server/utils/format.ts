/**
 * Shared formatting for the CMS's own screens.
 *
 * A revision's timestamp, a conflict's timestamp and a token's dates are all
 * shown the same way — an en-GB, medium/short date in UTC — so the copy lives
 * here once rather than as a copy per template. The callers append the "UTC"
 * suffix themselves, because some render it in prose ("at 14 Oct 2026, 15:25
 * UTC.") and some as a caption.
 */
/** A date alone, in the en-GB UTC style: "11 Jan 2026". */
export const formatDay = (date: Date): string =>
  date.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/**
 * A date and time: "11 Jan 2026, 09:00".
 *
 * Composed rather than `toLocaleString({ dateStyle, timeStyle })`, because the
 * separator that joins the two is ICU's to choose and it changed: newer ICU
 * gives en-GB "11 Jan 2026 at 09:00". That is not only a different string to
 * assert, it is wrong copy here — `slot-form` and `page-form` introduce this
 * value with their own "at" ("…, at {formatWhen(…)} UTC."), which read "at 11
 * Jan 2026 at 09:00 UTC." on any machine with the newer data. Joining the two
 * parts ourselves keeps the comma the callers are written around, and keeps
 * the output the same whatever ICU the host ships.
 */
export const formatWhen = (date: Date): string =>
  `${formatDay(date)}, ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })}`;

/** A date without the year, for button labels: "11 Jan". */
export const formatDayShort = (date: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * A clock time alone, in the same 24-hour UTC style as `formatWhen`: "14:32".
 *
 * History's Restore buttons name a revision as "the 11 Jan 14:32 version" — a
 * day alone is not enough to tell two revisions on the same day apart, and the
 * row's own line already carries the year and the UTC suffix.
 */
export const formatTime = (date: Date): string =>
  date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
