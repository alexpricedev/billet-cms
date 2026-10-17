/**
 * The UUID check every CMS route shares. The pattern itself lives in
 * `utils/uuid`, a module with no imports, so the media service can filter the
 * ids a draft references without loading this controller module; it is
 * re-exported here so the routes keep reading it from one place.
 */
export { UUID_PATTERN } from "../../utils/uuid";

/** A trimmed non-empty form value, or null. */
export const nonEmpty = (value: FormDataEntryValue | null): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The largest a posted `content` document may be, in bytes — about 1 MB.
 *
 * The whole block or page document rides in one hidden field. A real document is
 * tens of kilobytes; the cap is far above any editor's content and far below a
 * body that would spend real memory and CPU to parse. Anything over it is
 * refused before it is parsed, so a hostile or runaway post can't make the save
 * handler allocate an unbounded document.
 */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** Why a posted `content` field could not be used. */
export type ContentParseFailure = "unreadable" | "too-large";

export type ContentParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: ContentParseFailure };

/**
 * Parse the posted `content` field, telling "malformed" apart from "too large".
 *
 * The two are different to the editor: a document past the byte cap is refused
 * before it is even measured as JSON, and saying so is the difference between
 * "try again" and "your document is too big to save".
 */
export const parseContent = (
  value: FormDataEntryValue | null,
): ContentParseResult => {
  if (typeof value !== "string" || value === "") {
    return { ok: false, reason: "unreadable" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: "unreadable" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
};

/** The message the editor sees when a posted `content` field can't be used. */
export const contentParseMessage = (reason: ContentParseFailure): string =>
  reason === "too-large"
    ? "That content is too large to save — keep the draft under 1 MB."
    : "The submitted content could not be read.";
