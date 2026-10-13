/**
 * A path the browser will follow on the site, or `null`.
 *
 * Two things the plugin builds from stored content become a browser navigation:
 * a redirect's `Location`, and the `previewPath` a slot declares so the CMS's
 * Preview button opens the page the slot lives on. A value that isn't a
 * same-origin path would navigate the browser off-site, so it is constrained
 * here: it must start with `/` and not `//` (protocol-relative goes off-site)
 * or carry a backslash (browsers read `\` as `/`, so `/\host` is `//host` in
 * disguise). The catch-all refuses anything else as a redirect and moves on,
 * and `slot()` refuses it at the declaration.
 */
export const sameOriginPath = (path: string): string | null => {
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//")) return null;
  if (path.includes("\\")) return null;
  return path;
};
