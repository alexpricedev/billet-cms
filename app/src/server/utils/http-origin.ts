// Parsing for a configured http(s) URL, and the origin of one.
//
// Three configured URLs are held to this one rule so they cannot drift: the
// origin a preview link opens (`SITE_APP_URL`, in `services/content/preview.ts`),
// the bucket origin the CSP adds to `img-src` (`MEDIA_PUBLIC_BASE_URL`, in
// `utils/security-headers.ts`), and the public URL uploads are stored under
// (`MEDIA_PUBLIC_BASE_URL` again, in `services/media/storage.ts`).
//
// `new URL` alone is not enough. It parses `ftp://bucket.example` happily and
// reports `.origin` as the real string `ftp://bucket.example`, which is not an
// origin a page can load; for `data:`/`javascript:` it reports the literal
// string `"null"`, which is truthy and would pass a bare existence check. Only
// http(s) is returned; anything else — a bare host, a relative path, a
// non-http scheme, an unparseable value — is `null`.

/**
 * A configured value as an http(s) `URL`, or `null` if it isn't one.
 *
 * `httpOrigin` is built on this so a caller that needs the full URL (a path
 * prefix, say) and one that needs just the origin reject the same values.
 */
export const httpUrl = (value: string | null | undefined): URL | null => {
  const configured = value?.trim();
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

/** The origin of a configured http(s) URL, or `null`. */
export const httpOrigin = (value: string | null | undefined): string | null =>
  httpUrl(value)?.origin ?? null;
