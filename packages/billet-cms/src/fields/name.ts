/**
 * The names a site declares: blocks, their fields, page types and slots.
 *
 * A name becomes a key in stored JSON, a column value and — for a slot — the
 * page it is listed under, so the constructors check it where the developer
 * writes it. A name that failed here would otherwise surface much later as a
 * form the CMS can't build or a page that won't validate, with nothing pointing
 * back at the declaration.
 *
 * The pattern is deliberately narrow: a lowercase letter first, then up to 63
 * letters, digits, underscores or hyphens. Slots relax it by allowing `.`, so a
 * slot can name the page it sits on while staying one name (`"home.hero"`).
 */

/** The name of a block, a field or a page type. */
export const NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

/**
 * A slot name: a `NAME_PATTERN`-style segment, then `.`-separated non-empty
 * segments, e.g. `"home.hero"` or `"footer.legal-notice"`.
 *
 * A dotted name used to be a single character class that allowed a dot
 * anywhere, so `"home..hero"`, `".hero"` and `"home."` all passed and then
 * named a page the CMS could never match. The pattern is anchored per segment
 * instead, and the lookahead caps the whole name at 64 characters — the same
 * limit a single-segment name carries.
 */
export const SLOT_NAME_PATTERN =
  /^(?=.{1,64}$)[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;

const nameRule = (pattern: RegExp): string =>
  pattern === SLOT_NAME_PATTERN
    ? "names must match ^[a-z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$ within 64 " +
      'characters — dot-separated segments with no empties (e.g. "home.hero")'
    : "names must match ^[a-z][a-zA-Z0-9_-]{0,63}$ — a lowercase letter, then " +
      'up to 63 letters, digits, "_" or "-"';

export interface NameCheckOptions {
  /** Defaults to `NAME_PATTERN`; slots pass `SLOT_NAME_PATTERN`. */
  pattern?: RegExp;
  /** Where the name was declared, e.g. `in block "hero"` for a field. */
  context?: string;
}

/**
 * Throw unless `value` is a name of the given kind.
 *
 * `kind` is the noun the message leads with ("block", "page type", "slot",
 * "field"), so the error reads as the declaration the developer wrote.
 */
export const assertName = (
  value: unknown,
  kind: string,
  options: NameCheckOptions = {},
): void => {
  const pattern = options.pattern ?? NAME_PATTERN;
  if (typeof value === "string" && pattern.test(value)) return;

  const where = options.context === undefined ? "" : ` ${options.context}`;
  throw new Error(
    `Invalid ${kind} name ${JSON.stringify(value)}${where}: ${nameRule(pattern)}`,
  );
};
