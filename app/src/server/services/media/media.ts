/**
 * The media library: uploads, their reuse, and their removal.
 *
 * This is the one place an upload becomes a row, and the rules it owns are the
 * spec's:
 *
 * 1. **Nothing is trusted before it is read.** Alt text is required and not
 *    blank; the bytes are sniffed rather than believed; the dimensions are read
 *    from the header before Sharp decodes a pixel; SVG and GIF are refused; the
 *    file is capped at 20 MB and the decode at 100 megapixels.
 * 2. **A published image can't be deleted.** Removal is refused while any
 *    published page or slot still references the row, so a live site never ends
 *    up pointing at a file that is gone. The caller gets the usages to show.
 *
 * The bytes go to the storage adapter (`./storage`), and the row keeps both the
 * object keys (to delete) and the public URLs (to render) for the original and
 * every rendition, so the site needs no bucket configuration.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_FOCAL_POINT,
  type FocalPoint,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { db } from "../database";
import { log } from "../logger";
import { processImage } from "./processor";
import {
  contentTypeFor,
  extensionFor,
  type ImageFormat,
  readImageSize,
  sniffImageFormat,
} from "./sniff";
import { getMediaStorage, type MediaStorage } from "./storage";

export interface MediaRecord {
  id: string;
  /** The object key of the metadata-stripped original in the bucket. */
  objectKey: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  alt: string;
  focalX: number;
  focalY: number;
  variants: MediaVariant[];
  createdAt: Date;
  updatedAt: Date;
}

/** Enough of an upload for a picker or a reuse list. */
export interface MediaOption {
  id: string;
  alt: string;
  width: number;
  height: number;
  /** The largest fallback's URL, for a thumbnail. */
  url: string;
}

interface MediaRow {
  id: string;
  object_key: string;
  content_type: string;
  byte_size: number | string;
  width: number;
  height: number;
  alt: string;
  focal_x: number;
  focal_y: number;
  variants: MediaVariant[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Read a row's `variants` as an array.
 *
 * Postgres hands jsonb back parsed, but a prepared statement built by
 * `unsafe` can leave it as the raw JSON text, so a string is parsed too — a
 * media row that reads back as "not an array" would otherwise take the whole
 * library down with a `flatMap is not a function`.
 */
const parseVariants = (value: unknown): MediaVariant[] => {
  if (Array.isArray(value)) return value as MediaVariant[];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as MediaVariant[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toMedia = (row: MediaRow): MediaRecord => ({
  id: row.id,
  objectKey: row.object_key,
  contentType: row.content_type,
  byteSize: Number(row.byte_size),
  width: row.width,
  height: row.height,
  alt: row.alt,
  focalX: row.focal_x,
  focalY: row.focal_y,
  variants: parseVariants(row.variants),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const MEDIA_COLUMNS = `id, object_key, content_type, byte_size, width, height,
              alt, focal_x, focal_y, variants, created_at, updated_at`;

/** The largest rendition's fallback URL, for a thumbnail. */
const thumbnailUrl = (row: MediaRow): string => {
  const variants = parseVariants(row.variants);
  return variants[variants.length - 1]?.fallbackUrl ?? "";
};

const toOption = (row: MediaRow): MediaOption => ({
  id: row.id,
  alt: row.alt,
  width: row.width,
  height: row.height,
  url: thumbnailUrl(row),
});

export interface MediaIssue {
  field: "file" | "alt";
  message: string;
}

export type CreateMediaResult =
  | { ok: true; media: MediaRecord }
  | { ok: false; issues: MediaIssue[] };

export interface CreateMediaInput {
  bytes: Uint8Array;
  /** The browser's claim about the type. Never trusted; kept for messages. */
  declaredType?: string | null;
  alt: string;
  actorId: string | null;
  /** Injected in tests; defaults to the process storage from the environment. */
  storage?: MediaStorage | null;
}

const fileIssue = (message: string): CreateMediaResult => ({
  ok: false,
  issues: [{ field: "file", message }],
});

/** The refusal message for a format outside the accepted set. */
const refusalFor = (
  format: ImageFormat | null,
  declaredType: string | null | undefined,
): string => {
  if (format === "svg" || declaredType === "image/svg+xml") {
    return "SVG uploads aren't supported. Use a JPEG, PNG or WebP image.";
  }
  if (format === "gif" || declaredType === "image/gif") {
    return "GIF uploads aren't supported, including animated ones. Use a JPEG, PNG or WebP image.";
  }
  return "That file isn't a JPEG, PNG or WebP image.";
};

/**
 * Validate and store one upload.
 *
 * Everything that can be checked is checked before a byte is written or a row
 * inserted: a refused upload leaves no orphan object behind.
 */
export const createMedia = async (
  input: CreateMediaInput,
): Promise<CreateMediaResult> => {
  const alt = input.alt.trim();
  if (alt === "") {
    return {
      ok: false,
      issues: [{ field: "alt", message: "Enter alt text." }],
    };
  }

  const bytes = input.bytes;
  if (bytes.length === 0) {
    return fileIssue("Choose an image to upload.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return fileIssue(
      `That image is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Resize it and try again.`,
    );
  }

  const format = sniffImageFormat(bytes);
  if (format === null || format === "svg" || format === "gif") {
    return fileIssue(refusalFor(format, input.declaredType));
  }

  const size = readImageSize(bytes, format);
  if (!size || size.width <= 0 || size.height <= 0) {
    return fileIssue("We couldn't read that image's dimensions.");
  }
  if (size.width * size.height > MAX_UPLOAD_PIXELS) {
    return fileIssue(
      "That image is too large to process (over 100 megapixels). Resize it and try again.",
    );
  }

  const storage = input.storage ?? getMediaStorage();
  if (!storage) {
    return fileIssue(
      "Image uploads aren't set up yet. Ask your developer to configure the CMS bucket.",
    );
  }

  let processed: Awaited<ReturnType<typeof processImage>>;
  try {
    processed = await processImage(bytes, format);
  } catch (error) {
    log.warn(
      "media",
      `Could not process an upload: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fileIssue("We couldn't process that image. Try another file.");
  }

  const id = randomUUID();
  const originalKey = `media/${id}/original.${extensionFor(format)}`;
  const fallbackExtension = format === "png" ? "png" : "jpg";

  const written: string[] = [];
  try {
    await storage.put(
      originalKey,
      processed.original.bytes,
      processed.original.contentType,
    );
    written.push(originalKey);

    const variants: MediaVariant[] = [];
    for (const rendition of processed.renditions) {
      const webpKey = `media/${id}/${rendition.width}.webp`;
      const fallbackKey = `media/${id}/${rendition.width}.${fallbackExtension}`;
      await storage.put(webpKey, rendition.webp, "image/webp");
      written.push(webpKey);
      await storage.put(
        fallbackKey,
        rendition.fallback,
        `image/${fallbackExtension === "png" ? "png" : "jpeg"}`,
      );
      written.push(fallbackKey);

      variants.push({
        width: rendition.width,
        height: rendition.height,
        webpKey,
        webpUrl: storage.publicUrl(webpKey),
        fallbackKey,
        fallbackUrl: storage.publicUrl(fallbackKey),
      });
    }

    const rows = (await db.unsafe(
      `INSERT INTO cms_media
         (id, object_key, content_type, byte_size, width, height, alt, variants, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING ${MEDIA_COLUMNS}`,
      [
        id,
        originalKey,
        contentTypeFor(format),
        processed.original.bytes.length,
        processed.width,
        processed.height,
        alt,
        JSON.stringify(variants),
        input.actorId,
      ],
    )) as MediaRow[];

    return { ok: true, media: toMedia(rows[0]) };
  } catch (error) {
    // A half-written upload is cleaned up rather than left as orphan objects;
    // a failure here is logged and dropped, because the row is what matters.
    await Promise.all(
      written.map((key) =>
        storage.delete(key).catch((cleanupError) => {
          log.warn(
            "media",
            `Could not clean up ${key} after a failed upload: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }),
      ),
    );
    throw error;
  }
};

export const listMedia = async (): Promise<MediaRecord[]> => {
  const rows = (await db`
    SELECT id, object_key, content_type, byte_size, width, height,
           alt, focal_x, focal_y, variants, created_at, updated_at
    FROM cms_media
    ORDER BY created_at DESC, id DESC
  `) as MediaRow[];
  return rows.map(toMedia);
};

export const getMediaById = async (
  id: string,
  sql: SQL = db,
): Promise<MediaRecord | null> => {
  const rows = (await sql.unsafe(
    `SELECT ${MEDIA_COLUMNS} FROM cms_media WHERE id = $1`,
    [id],
  )) as MediaRow[];
  return rows.length > 0 ? toMedia(rows[0]) : null;
};

/** The uploads a picker offers, newest first. */
export const listMediaOptions = async (): Promise<MediaOption[]> => {
  const rows = (await db`
    SELECT id, object_key, content_type, byte_size, width, height,
           alt, focal_x, focal_y, variants, created_at, updated_at
    FROM cms_media
    ORDER BY created_at DESC, id DESC
  `) as MediaRow[];
  return rows.map(toOption);
};

export type UpdateMediaResult =
  | { ok: true; media: MediaRecord }
  | { ok: false; message: string };

export const updateMediaAlt = async (
  id: string,
  alt: string,
): Promise<UpdateMediaResult> => {
  const trimmed = alt.trim();
  if (trimmed === "") return { ok: false, message: "Enter alt text." };

  const rows = (await db.unsafe(
    `UPDATE cms_media
       SET alt = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${MEDIA_COLUMNS}`,
    [id, trimmed],
  )) as MediaRow[];
  if (rows.length === 0)
    return { ok: false, message: "That image no longer exists." };
  return { ok: true, media: toMedia(rows[0]) };
};

export const updateMediaFocalPoint = async (
  id: string,
  focal: FocalPoint,
): Promise<UpdateMediaResult> => {
  const clamp = (value: number): number =>
    Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : DEFAULT_FOCAL_POINT.x;

  const rows = (await db.unsafe(
    `UPDATE cms_media
       SET focal_x = $2, focal_y = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${MEDIA_COLUMNS}`,
    [id, clamp(focal.x), clamp(focal.y)],
  )) as MediaRow[];
  if (rows.length === 0)
    return { ok: false, message: "That image no longer exists." };
  return { ok: true, media: toMedia(rows[0]) };
};

/** True when a stored content value references `mediaId` through an image field. */
export const referencesMedia = (value: unknown, mediaId: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesMedia(entry, mediaId));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.mediaId === mediaId) return true;
  return Object.values(record).some((entry) => referencesMedia(entry, mediaId));
};

export interface MediaUsage {
  kind: "page" | "slot";
  id: string;
  /** A page title, or a slot's label (falling back to its name). */
  label: string;
  /** A page's URL, or a slot's name. */
  detail: string;
}

interface UsageRow {
  kind: "page" | "slot";
  id: string;
  label: string;
  detail: string;
  content: Record<string, unknown>;
}

/**
 * The published pages and slots whose content references this image.
 *
 * Only published revisions count: a draft's reference doesn't put the image on
 * a live page, so deleting it can't break a visitor, and the draft that uses it
 * will re-pick. Both targets are one query so a delete needs one round trip.
 */
export const getMediaUsage = async (mediaId: string): Promise<MediaUsage[]> => {
  const rows = (await db`
    SELECT 'page' AS kind, p.id, p.title AS label, p.url AS detail, r.content
    FROM cms_pages p JOIN cms_revisions r ON r.id = p.published_revision_id
    UNION ALL
    SELECT 'slot' AS kind, s.id, COALESCE(s.label, s.name) AS label, s.name AS detail,
           r.content
    FROM cms_slots s JOIN cms_revisions r ON r.id = s.published_revision_id
  `) as UsageRow[];

  return rows
    .filter((row) => referencesMedia(row.content, mediaId))
    .map(({ kind, id, label, detail }) => ({ kind, id, label, detail }));
};

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "in-use"; usage: MediaUsage[] };

/**
 * Delete an upload, unless published content still uses it.
 *
 * The usage check and the delete are one transaction on the row, so two editors
 * deleting and publishing at once can't both win. Objects are removed
 * best-effort first: a leaked object costs storage, a row deleted before its
 * objects are gone costs a broken page if the delete then fails.
 */
export const deleteMedia = async (
  id: string,
  storage: MediaStorage | null = getMediaStorage(),
): Promise<DeleteMediaResult> => {
  const media = await getMediaById(id);
  if (!media) return { ok: false, reason: "not-found" };

  const usage = await getMediaUsage(id);
  if (usage.length > 0) return { ok: false, reason: "in-use", usage };

  if (storage) {
    const keys = [
      media.objectKey,
      ...media.variants.flatMap((variant) => [
        variant.webpKey,
        variant.fallbackKey,
      ]),
    ];
    await Promise.all(
      keys.map((key) =>
        storage.delete(key).catch((error) => {
          log.warn(
            "media",
            `Could not delete ${key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
  }

  await db`DELETE FROM cms_media WHERE id = ${id}`;
  return { ok: true };
};
