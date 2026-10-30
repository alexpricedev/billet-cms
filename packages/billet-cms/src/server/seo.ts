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
 *     one. A page's social image is a media id, so it is read through the
 *     plugin's media reader and comes back as a public URL — hence async.
 *   - `renderSeoTags` renders the canonical and social tags for a site that
 *     wants them as a fragment (a layout the site does not want to thread a
 *     social image through), and `renderSitemapEntries` does the same for the
 *     sitemap's `<url>` entries.
 *
 * The site decides where the markup goes. `renderSeoTags` and
 * `renderSitemapEntries` are pure functions of already-loaded data; `pageSeo`
 * is the one that reads, and only when the page names a social image.
 */
import type { MediaVariant } from "../contract";
import type { CmsMediaReader } from "./media";
import type { CmsPage, CmsSitemapEntry } from "./pages";
import { escapeHtml } from "./rich-text";

/**
 * The narrowest rendition worth putting in a share card.
 *
 * Open Graph's large-image card is 1200×630; a narrower picture is upscaled by
 * the scraper and reads as blurry, so prefer the smallest rendition that is at
 * least this wide and fall back to the widest there is.
 */
const OG_IMAGE_MIN_WIDTH = 1200;

export interface PageSeo {
  title: string;
  description: string;
  /** The page's path, e.g. `/about` — the runbook's `canonicalPath`. */
  canonicalPath: string;
  /** An absolute URL for a social image, when the page sets one. */
  socialImage: string | null;
}

export interface PageSeoOptions {
  /**
   * The site's canonical origin (`SITE_URL`, else `APP_URL`'s origin). Only
   * needed to resolve a relative social image URL; the tags do their own
   * resolving.
   */
  siteUrl?: string;
  /** Used when the page has no SEO description of its own. */
  fallbackDescription?: string;
  /**
   * The plugin's media reader (`getCmsMediaReader(sql)`, or the `getMedia`-only
   * shape for a test). A page's social image is a `cms_media` id, so resolving
   * it needs a reader; without one no `og:image` is emitted, which is what a
   * site that renders its own share card wants.
   */
  media?: Pick<CmsMediaReader, "getMedia">;
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
 * The public URL of the rendition a share card should use.
 *
 * `variants` arrives ascending by width (`CmsMedia`'s contract). The first one
 * at least as wide as a large card is the smallest that will not be upscaled;
 * when every rendition is narrower, the largest is still the best there is.
 * The fallback rendition rather than the WebP: `og:image` is one URL with no
 * `srcset`, and a scraper that cannot decode WebP would show nothing at all.
 */
const shareImageUrl = (variants: readonly MediaVariant[]): string | null => {
  if (variants.length === 0) return null;
  const variant =
    variants.find((candidate) => candidate.width >= OG_IMAGE_MIN_WIDTH) ??
    variants[variants.length - 1];
  return variant.fallbackUrl;
};

/**
 * Resolve a page's social image id to an absolute URL.
 *
 * An unset id, a site that passed no media reader, a deleted upload and an
 * upload with no renditions all leave `og:image` off, exactly as an unset image
 * did when the page stored a URL: the media reader already turns a failed read
 * into `null` and logs it, so nothing here can throw inside a render.
 */
const socialImageUrl = async (
  mediaId: string | null,
  options: PageSeoOptions,
): Promise<string | null> => {
  if (!mediaId || !options.media) return null;

  const media = await options.media.getMedia(mediaId);
  const url = media ? shareImageUrl(media.variants) : null;
  if (!url) return null;

  return options.siteUrl ? absolute(options.siteUrl, url) : url;
};

/**
 * The page's SEO values.
 *
 * The title and canonical path are the page's own; the description falls back to
 * the site's default so an unset SEO description never renders an empty
 * `<meta name="description">`, which the runbook treats as a per-page omission.
 * A description that is only whitespace counts as unset and falls back too, so
 * an editor who clears the field gets the site default rather than a blank tag.
 *
 * Async because a social image id has to be read as a `cms_media` row; a page
 * that sets none costs no read.
 */
export const pageSeo = async (
  page: CmsPage,
  options: PageSeoOptions = {},
): Promise<PageSeo> => {
  const socialImage = await socialImageUrl(page.socialImageId, options);

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
  // `pageSeo` trims, but a hand-built `PageSeo` can still carry whitespace: a
  // blank description is a per-page omission, not a tag full of spaces.
  const hasDescription = seo.description.trim() !== "";

  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:title" content="${title}">`,
  ];

  // An empty description is a per-page omission, not an empty tag: a site with
  // no fallback for a page that never set one leaves both description tags out
  // rather than rendering `content=""`.
  if (hasDescription) {
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
  if (hasDescription) {
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
