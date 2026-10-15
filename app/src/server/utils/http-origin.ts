// The origin of a configured http(s) URL, or `null`.
//
// Two configured URLs end up in a browser navigation or a source allowlist, and
// both are validated by this one rule so they cannot drift: `SITE_APP_URL`, the
// origin a preview link opens (`services/content/preview.ts`), and
// `MEDIA_PUBLIC_BASE_URL`, the bucket origin the CSP adds to `img-src`
// (`utils/security-headers.ts`).
//
// `new URL` alone is not enough. It parses `ftp://bucket.example` happily and
// reports `.origin` as the real string `ftp://bucket.example`, which is not an
// origin a page can load; for `data:`/`javascript:` it reports the literal
// string `"null"`, which is truthy and would pass a bare existence check. Only
// http(s) is returned; anything else — a bare host, a relative path, a
// non-http scheme, an unparseable value — contributes nothing.
export const httpOrigin = (value: string | null | undefined): string | null => {
  const configured = value?.trim();
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};
