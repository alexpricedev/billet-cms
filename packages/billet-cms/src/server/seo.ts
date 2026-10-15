/**
 * SEO helpers for a CMS page, following Billet's SEO runbook.
 *
 * The runbook's rule is that every public page sets a unique `title`, a
 * `description` and a `canonicalPath`, and that the canonical and social tags
 * are built from the same canonical origin as the site's own links (`siteUrl()`
 * in the site's `services/seo.ts` — `SITE_URL`, or `APP_URL`'s origin). The
 * plugin cannot render the site's `<head>` — that is the site's layout — so it
 * splits the job the same way the reader does:
 *
 *   - `pageSeo` turns a page's stored settings into the values the runbook's
 *     `Layout` expects, with a description fallback for a page that never set
 *     one.
 *   - `renderSeoTags` renders the canonical and social tags for a site that
 *     wants them as a fragment (a layout the site does not want to thread a
 *     social image through), and `renderSitemapEntries` does the same for the
 *     sitemap's `<url>` entries.
 *
 * Everything here is a pure function of already-loaded data: no database, no
 * clock, no layout. The site decides where the markup goes.
 */
import type { CmsPage, CmsSitemapEntry } from "./pages";
import { escapeHtml } from "./rich-text";

export interface PageSeo {
  title: string;
  description: string;
  /** The page's path, e.g. `/about` — the runbook's `canonicalPath`. */
  canonicalPath: string;
  /** An absolute URL for a social image, when the page set one. */
  socialImage: string | null;
}

export interface PageSeoOptions {
  /**
   * The site's canonical origin (`SITE_URL`, else `APP_URL`'s origin). Only
   * needed to resolve a relative social image; the tags do their own resolving.
   */
  siteUrl?: string;
  /** Used when the page has no SEO description of its own. */
  fallbackDescription?: string;
}

/**
 * Resolve a path or URL against the canonical origin, or return it unchanged.
 *
 * A page's stored settings are validated on write, but the site can call these
 * helpers with anything — an unset `siteUrl`, a hand-edited row, a value from a
 * database the CMS doesn't own. `new URL` throws on a malformed base or path,
 * and a thrown error inside a render is a 500 on a public page, so resolution
 * falls back to the value as given (escaped by the caller) instead.
 */
const absolute = (siteUrl: string, path: string): string => {
  try {
    return new URL(path, siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).href;
  } catch {
    return path;
  }
};

/**
 * The page's SEO values.
 *
 * The title and canonical path are the page's own; the description falls back to
 * the site's default so an unset SEO description never renders an empty
 * `<meta name="description">`, which the runbook treats as a per-page omission.
 * A description that is only whitespace counts as unset and falls back too, so
 * an editor who clears the field gets the site default rather than a blank tag.
 */
export const pageSeo = (
  page: CmsPage,
  options: PageSeoOptions = {},
): PageSeo => {
  const socialImage = page.socialImage
    ? options.siteUrl
      ? absolute(options.siteUrl, page.socialImage)
      : page.socialImage
    : null;

  return {
    title: page.title,
    description:
      page.seoDescription?.trim() || options.fallbackDescription?.trim() || "",
    canonicalPath: page.url,
    socialImage,
  };
};

export interface SeoTagOptions {
  /** The canonical origin — `SITE_URL`, else `APP_URL`'s origin. */
  siteUrl: string;
}

/**
 * The canonical link and the Open Graph / Twitter tags for one page.
 *
 * Mirrors the runbook's `Layout` (canonical, `og:title`/`description`/`url`/`type`
 * and the `twitter:*` mirror) and adds the page's social image where the layout
 * would otherwise always use the site default. An empty description omits both
 * description tags rather than rendering `content=""`, which the runbook treats
 * as a per-page omission. Values are escaped: a page title is editor input, and
 * an attribute is exactly where an unescaped quote becomes markup.
 */
export const renderSeoTags = (seo: PageSeo, options: SeoTagOptions): string => {
  const canonical = absolute(options.siteUrl, seo.canonicalPath);
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);

  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:title" content="${title}">`,
  ];

  // An empty description is a per-page omission, not an empty tag: a site with
  // no fallback for a page that never set one leaves both description tags out
  // rather than rendering `content=""`.
  if (seo.description !== "") {
    tags.push(`<meta property="og:description" content="${description}">`);
  }

  tags.push(
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    '<meta property="og:type" content="website">',
  );

  if (seo.socialImage) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(seo.socialImage)}">`,
    );
  }

  tags.push('<meta name="twitter:card" content="summary_large_image">');
  tags.push(`<meta name="twitter:title" content="${title}">`);
  if (seo.description !== "") {
    tags.push(`<meta name="twitter:description" content="${description}">`);
  }

  if (seo.socialImage) {
    tags.push(
      `<meta name="twitter:image" content="${escapeHtml(seo.socialImage)}">`,
    );
  }

  return tags.join("\n");
};

/**
 * The `<url>` entries a site appends to its own `<urlset>`.
 *
 * The runbook's sitemap is generated from a list of canonical paths; a CMS page
 * is another canonical, indexable public URL, so it belongs in the same list.
 * Only published pages are returned by the reader, so a draft never leaks into
 * the sitemap. Each entry carries a `<lastmod>` from the page's `updated_at`.
 */
export const renderSitemapEntries = (
  entries: readonly CmsSitemapEntry[],
  options: SeoTagOptions,
): string =>
  entries
    .map((entry) => {
      const loc = escapeHtml(absolute(options.siteUrl, entry.url));
      const lastmod = entry.lastModified.toISOString();
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    })
    .join("\n");
