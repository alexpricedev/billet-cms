/**
 * Reading uploads and rendering them, for the site.
 *
 * An `image()` field stores only a `mediaId`. The picture itself — its size,
 * its renditions and its focal point — is a `cms_media` row, so the site reads
 * that row through this module and hands the result to `renderCmsImage`, the
 * plugin's `<CmsImage>`:
 *
 *   const media = await getMedia(sql, content.photo.mediaId);
 *   return media ? renderCmsImage(media, { alt: content.photo.alt }) : "";
 *
 * `renderCmsImage` emits a `<picture>`: a WebP `<source>` and the original
 * format as the fallback, both with a full `srcset`, plus `width`/`height` so
 * the browser reserves the right space (`object-fit: cover` and
 * `object-position` from the focal point are in the inline style). Nothing is
 * fetched and nothing is assumed: a row that is missing or has no renditions
 * reads as `null`, and the caller renders nothing rather than a broken image.
 *
 * Reads are cached per process against `cms_meta.content_version` (Q3), the
 * same poll the page and slot readers use, so a focal-point or alt change
 * shows within about a second and the steady state costs no queries. A missing
 * `cms_media` table — an un-migrated CMS — is a skip and a log, never a 500 on
 * a public page.
 */
import type { SQL } from "bun";
import {
  DEFAULT_FOCAL_POINT,
  type FocalPoint,
  type MediaVariant,
  TABLES,
} from "../contract";
import { ContentCache, readerCacheOptions } from "./cache";
import { defaultSkipLogger, type SkipLogger } from "./log";
import { escapeHtml } from "./rich-text";

/** One upload, ready to render. */
export interface CmsMedia {
  id: string;
  /** The media item's own alt text; a use may override it. */
  alt: string;
  width: number;
  height: number;
  focalPoint: FocalPoint;
  /** Ascending by width. Empty only for a row a hand-edit left broken. */
  variants: MediaVariant[];
}

interface MediaRow {
  id: string;
  alt: string;
  width: number;
  height: number;
  focal_x: number;
  focal_y: number;
  variants: MediaVariant[] | null;
}

export interface CmsMediaOptions {
  /** The site's pool, shared with its own Billet tables. */
  sql: SQL;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often `content_version` is re-read. Defaults to one second (Q3). */
  versionPollMs?: number;
  /**
   * Where skipped reads are reported. Defaults to the console.
   *
   * It does not receive `content_version` poll failures: the poll is shared
   * between every reader on the pool, so it logs through the default logger
   * rather than any one reader's sink. A reader built with an injected `now`
   * gets a private poll and does report through this logger.
   */
  onSkip?: SkipLogger;
}

export interface CmsMediaReader {
  /** The upload with this id, or `null` when there is none to render. */
  getMedia(id: string): Promise<CmsMedia | null>;
  /**
   * A hard reset: drop every cached entry and re-read `content_version` on the
   * next read.
   */
  invalidate(): void;
}

const toMedia = (row: MediaRow): CmsMedia => ({
  id: row.id,
  alt: row.alt,
  width: row.width,
  height: row.height,
  focalPoint: {
    x: Number(row.focal_x ?? DEFAULT_FOCAL_POINT.x),
    y: Number(row.focal_y ?? DEFAULT_FOCAL_POINT.y),
  },
  variants: Array.isArray(row.variants)
    ? [...row.variants].sort((a, b) => a.width - b.width)
    : [],
});

export const createCmsMedia = (options: CmsMediaOptions): CmsMediaReader => {
  const { sql } = options;
  const onSkip = options.onSkip ?? defaultSkipLogger;

  const loadMedia = async (id: string): Promise<CmsMedia | null> => {
    const rows = (await sql.unsafe(
      `SELECT id, alt, width, height, focal_x, focal_y, variants
       FROM ${TABLES.media} WHERE id = $1`,
      [id],
    )) as MediaRow[];
    return rows[0] ? toMedia(rows[0]) : null;
  };

  const cache = new ContentCache<CmsMedia | null>({
    // One poll for the whole pool, shared with the slot and page readers, so a
    // process asks `cms_meta` once a second rather than once per reader. A
    // failed version check is logged by the shared poll through the default
    // logger, not this reader's `onSkip` (see `readerCacheOptions`).
    ...readerCacheOptions(sql, options, onSkip),
    load: loadMedia,
  });

  return {
    async getMedia(id: string): Promise<CmsMedia | null> {
      try {
        return await cache.get(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onSkip(`could not read media "${id}": ${message}`);
        return null;
      }
    },

    invalidate(): void {
      cache.invalidate();
    },
  };
};

const readers = new WeakMap<SQL, CmsMediaReader>();

export const getCmsMediaReader = (sql: SQL): CmsMediaReader => {
  const existing = readers.get(sql);
  if (existing) return existing;
  const reader = createCmsMedia({ sql });
  readers.set(sql, reader);
  return reader;
};

/** The upload with this id, using a process-wide reader for `sql`. */
export const getMedia = (sql: SQL, id: string): Promise<CmsMedia | null> =>
  getCmsMediaReader(sql).getMedia(id);

export interface CmsImageOptions {
  /**
   * The alt text for this use. An image value may carry its own override; pass
   * it, or the media item's own alt is used.
   */
  alt?: string;
  /** The `sizes` attribute. Defaults to `100vw`. */
  sizes?: string;
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
  /** A class for the `<img>`, so a site can size it from its own CSS. */
  className?: string;
  /** Extra inline CSS, appended after the object-fit style. */
  style?: string;
}

const srcset = (
  variants: readonly MediaVariant[],
  url: (variant: MediaVariant) => string,
): string =>
  variants.map((variant) => `${url(variant)} ${variant.width}w`).join(", ");

/**
 * Render one upload as a `<picture>`.
 *
 * The WebP `<source>` and the fallback `<img>` carry matching `srcset`s, so a
 * browser picks the smallest rendition that fits the box and the format it can
 * decode. `object-fit: cover` with the focal point's `object-position` is what
 * makes the crop follow the editor's click. Returns an empty string when the
 * row has no renditions, so a caller can interpolate the result without a
 * broken `<img>`.
 */
export const renderCmsImage = (
  media: CmsMedia,
  options: CmsImageOptions = {},
): string => {
  if (media.variants.length === 0) return "";

  const alt = escapeHtml(options.alt ?? media.alt);
  const largest = media.variants[media.variants.length - 1];
  const x = Math.round(media.focalPoint.x * 1000) / 10;
  const y = Math.round(media.focalPoint.y * 1000) / 10;
  const position = `object-position:${x}% ${y}%`;
  const style = options.style
    ? `object-fit:cover;${position};${options.style}`
    : `object-fit:cover;${position}`;

  const attributes = [
    `src="${escapeHtml(largest.fallbackUrl)}"`,
    `srcset="${escapeHtml(srcset(media.variants, (variant) => variant.fallbackUrl))}"`,
    `sizes="${escapeHtml(options.sizes ?? "100vw")}"`,
    `width="${Number(media.width)}"`,
    `height="${Number(media.height)}"`,
    `alt="${alt}"`,
    `loading="${escapeHtml(options.loading ?? "lazy")}"`,
    `decoding="${escapeHtml(options.decoding ?? "async")}"`,
    `style="${escapeHtml(style)}"`,
    ...(options.className ? [`class="${escapeHtml(options.className)}"`] : []),
  ].join(" ");

  const webp = `<source type="image/webp" srcset="${escapeHtml(
    srcset(media.variants, (variant) => variant.webpUrl),
  )}" sizes="${escapeHtml(options.sizes ?? "100vw")}">`;

  return `<picture>${webp}<img ${attributes}></picture>`;
};
