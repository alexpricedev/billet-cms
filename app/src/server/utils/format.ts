/**
 * Shared formatting for the CMS's own screens.
 *
 * A revision's timestamp, a conflict's timestamp and a token's dates are all
 * shown the same way — an en-GB, medium/short date in UTC — so the copy lives
 * here once rather than as a copy per template. The callers append the "UTC"
 * suffix themselves, because some render it in prose ("at 14 Oct 2026, 15:25
 * UTC.") and some as a caption.
 */
export const formatWhen = (date: Date): string =>
  date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

/** A date alone, in the same en-GB UTC style: "11 Jan 2026". */
export const formatDay = (date: Date): string =>
  date.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** A date without the year, for button labels: "11 Jan". */
export const formatDayShort = (date: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
