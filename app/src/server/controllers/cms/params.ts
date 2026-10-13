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

/** Parse a JSON object out of a form field, or null when it isn't one. */
export const parseJsonObject = (
  value: FormDataEntryValue | null,
): Record<string, unknown> | null => {
  if (typeof value !== "string" || value === "") return null;
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
