/**
 * A site path, or a pattern matched against one, that stays on the site.
 *
 * Two things the plugin builds from stored content become a browser navigation:
 * a redirect's `Location`, and the `previewPath` a slot declares so the CMS's
 * Preview button opens the page the slot lives on. A value that isn't a
 * same-origin path would navigate the browser off-site, so it is constrained
 * here: it must start with `/` and not `//` (protocol-relative goes off-site)
 * or carry a backslash (browsers read `\` as `/`, so `/\host` is `//host` in
 * disguise). The catch-all refuses anything else as a redirect and moves on,
 * and `slot()` refuses it at the declaration.
 *
 * A `section()` path pattern is matched against a page's URL rather than
 * followed, but it is still written as a site path — `*` and `**` are given
 * their meaning by the matcher — so it has to obey the same rule. A pattern
 * that pointed off-site would group nothing, and the declaration should say so
 * rather than store a row the Pages list can never match.
 */
const sameOriginPathLike = (value: string): string | null => {
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  return value;
};

/** A path the browser will follow on the site, or `null`. */
export const sameOriginPath = sameOriginPathLike;

/**
 * A site path pattern a `section()` matches page URLs against, or `null`.
 *
 * `*` (within one path segment) and `**` (across any number of them) are
 * ordinary characters to this check; everything else is literal. The rule is
 * the one a followed path carries, because both name a location on this site.
 */
export const sameOriginPathPattern = sameOriginPathLike;
