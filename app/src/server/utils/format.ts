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
