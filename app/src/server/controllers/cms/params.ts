/**
 * The slot id comes straight from the URL. Postgres answers a non-UUID with
 * `invalid input syntax for type uuid`, which would surface as a 500 for what
 * is really a missing page, so every slot route checks it first.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A trimmed non-empty form value, or null. */
export const nonEmpty = (value: FormDataEntryValue | null): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The largest a posted `content` document may be, in bytes — about 1 MB.
 *
 * The whole block or page document rides in one hidden field. A real document is
 * tens of kilobytes; the cap is far above any editor's content and far below a
 * body that would spend real memory and CPU to parse. Anything over it is
 * treated as unreadable (the same path as malformed JSON), so a hostile or
 * runaway post can't make the save handler allocate an unbounded document.
 */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** Parse a JSON object out of a form field, or null when it isn't one. */
export const parseJsonObject = (
  value: FormDataEntryValue | null,
): Record<string, unknown> | null => {
  if (typeof value !== "string" || value === "") return null;
  if (Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};
