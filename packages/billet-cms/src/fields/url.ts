/**
 * The URL allowlist the link field and a rich text link mark share.
 *
 * A stored link is written straight into an anchor's `href` on the site, so a
 * `javascript:` or `data:` URL in either place is stored XSS waiting for the
 * first editor who pastes it — or for the AI layer to write it. The allowlist
 * is positive rather than a blocklist, because a blocklist misses the next
 * scheme: http(s), mailto, tel, a root-relative path, or a fragment.
 *
 * The pattern spells its schemes in explicit character classes instead of
 * using the `i` flag. `z.toJSONSchema` emits the source without flags, so a
 * case-insensitive regex would validate one set of URLs on the site and store a
 * `pattern` the CMS reads as case-sensitive — the two sides would disagree
 * about `HTTPS://…`. Written this way, the Zod schema and the stored JSON
 * Schema accept exactly the same strings.
 *
 * Protocol-relative `//host` is rejected: it starts like a relative path but
 * navigates off-site, which is not what `/…` is meant to allow. A backslash is
 * rejected wherever it appears for the same reason — browsers read `\` as `/`,
 * so `/\host` is `//host` in disguise. A scheme also needs something after it
 * (`https://` with no host is not a link), while a bare `/` or `#` is kept.
 */
export const URL_PATTERN =
  /^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s\\]+|[Mm][Aa][Ii][Ll][Tt][Oo]:[^\s\\]+|[Tt][Ee][Ll]:[^\s\\]+|\/(?![/\\])[^\s\\]*|#[^\s\\]*)$/;

/** The message shown when a link fails the allowlist. */
export const URL_PATTERN_MESSAGE =
  "Enter a link that starts with http://, https://, mailto:, tel:, / or #";
