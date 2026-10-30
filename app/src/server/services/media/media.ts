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
 * 2. **An image in use can't be deleted.** Removal is refused while any
 *    published page or slot's content references the row, or any page names it
 *    as its social image, so a live site never ends up pointing at a file that
 *    is gone. The caller gets the usages to show.
 *
 * The bytes go to the storage adapter (`./storage`), and the row keeps both the
 * object keys (to delete) and the public URLs (to render) for the original and
 * every rendition, so the site needs no bucket configuration.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_FOCAL_POINT,
  type FocalPoint,
  MAX_ALT_LENGTH,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { inList, jsonbValue } from "../../utils/sql";
import { filterUuids, UUID_PATTERN } from "../../utils/uuid";
import { bumpContentVersion } from "../content/publishing";
import { db } from "../database";
import { log } from "../logger";
import { collectMediaIds } from "./guidance";
import { MEDIA_PICKER_LIMIT } from "./limits";
import { processImage } from "./processor";
import {
  type ImageFormat,
  isAnimatedImage,
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

/**
 * The longest alt text the CMS stores, in characters.
 *
 * Re-exported from the contract so the media service, the generated form
 * controls and the site's own `image()` schema all read the one value: the cap
 * on a stored upload's alt and the cap on a per-use `alt` override must be the
 * same number, or a value the editor is allowed to type becomes one the save
 * refuses. The rationale lives on the constant in `@alexpricedev/billet-cms/contract`.
 */
export { MAX_ALT_LENGTH };

/**
 * Enough of an upload for a picker or a reuse list.
 *
 * Only what a form control shows. The thumbnail URL the old shape carried was
 * never read by a control, so it is not computed here; the options endpoint
 * reads `variants` separately (below) because only it renders thumbnails.
 */
export interface MediaOption {
  id: string;
  alt: string;
  width: number;
  height: number;
}

/** An option plus every rendition, so the picker can choose a thumbnail. */
export interface MediaOptionEntry extends MediaOption {
  variants: MediaVariant[];
}

/** One page of the picker's options, newest first. */
export interface MediaOptionsPage {
  items: MediaOptionEntry[];
  /** An opaque cursor for the next page, or null on the last one. */
  next: string | null;
}

export interface MediaOptionsPageOptions {
  /** A case-insensitive substring of the alt text. Blank matches everything. */
  q?: string | null;
  /** The `next` from a previous page. Malformed or absent starts at the top. */
  after?: string | null;
  /** The page size. Defaults to the picker's cap. */
  limit?: number;
}

interface MediaOptionRow extends MediaOptionEntry {
  /**
   * `created_at` as ISO-8601 UTC at the column's full microsecond precision.
   * Deliberately not aliased `created_at`: an output column of that name would
   * shadow the table column in `ORDER BY`, make the sort textual, and leave
   * `cms_media_created_at_idx` unusable on every picker query.
   */
  created_at_cursor: string;
}

interface OptionsCursor {
  /** `to_char`'d `created_at`, so the cursor carries its microseconds. */
  t: string;
  /** The id, the tie-break for two rows with the same timestamp. */
  i: string;
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const encodeOptionsCursor = (row: MediaOptionRow): string =>
  Buffer.from(JSON.stringify({ t: row.created_at_cursor, i: row.id })).toString(
    "base64url",
  );

/**
 * Read a page cursor, or null when it isn't one this service wrote.
 *
 * `after` comes from the query string, so anything at all can arrive. A cursor
 * that doesn't decode to our timestamp and id starts at the newest upload
 * rather than erroring: a stale or hand-edited link shows the first page, which
 * is a page the picker can use.
 */
const decodeOptionsCursor = (after: string | null): OptionsCursor | null => {
  if (!after) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(after, "base64url").toString("utf8"),
    ) as Partial<OptionsCursor> | null;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.t !== "string" ||
      !CURSOR_TIMESTAMP.test(parsed.t) ||
      typeof parsed.i !== "string" ||
      !UUID_PATTERN.test(parsed.i)
    ) {
      return null;
    }
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
};

/**
 * Escape the LIKE metacharacters in a search term.
 *
 * `_` matches any one character and `%` any run, so an alt search for "100%"
 * would otherwise match "100 miles". The backslash is Postgres's default LIKE
 * escape and is doubled here so a search for a literal one still works.
 */
const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, "\\$&");

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
 * The column is `jsonb`, so Postgres hands it back parsed; a value that isn't
 * an array — only a hand-edit could produce one — reads as empty rather than
 * taking the whole library down with a `flatMap is not a function`.
 */
const parseVariants = (value: unknown): MediaVariant[] =>
  Array.isArray(value) ? (value as MediaVariant[]) : [];

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
  if (alt.length > MAX_ALT_LENGTH) {
    return {
      ok: false,
      issues: [
        {
          field: "alt",
          message: `Alt text must be ${MAX_ALT_LENGTH} characters or fewer.`,
        },
      ],
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
  // An animated WebP or APNG passes the magic-byte sniff, but Sharp would store
  // only its first frame, so it is refused like a GIF (review r1-17).
  if (isAnimatedImage(bytes, format)) {
    return fileIssue(
      "Animated images aren't supported. Use a still JPEG, PNG or WebP image.",
    );
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
  const originalKey = `media/${id}/original.${processed.original.extension}`;

  // Everything the upload writes: the original plus a WebP and a fallback per
  // width, described up front so the puts can run together.
  const objects: { key: string; body: Uint8Array; contentType: string }[] = [
    {
      key: originalKey,
      body: processed.original.bytes,
      contentType: processed.original.contentType,
    },
  ];
  const variants: MediaVariant[] = [];
  for (const rendition of processed.renditions) {
    const webpKey = `media/${id}/${rendition.width}.webp`;
    const fallbackKey = `media/${id}/${rendition.width}.${rendition.fallbackExtension}`;
    objects.push(
      { key: webpKey, body: rendition.webp, contentType: "image/webp" },
      {
        key: fallbackKey,
        body: rendition.fallback,
        contentType: rendition.fallbackContentType,
      },
    );

    variants.push({
      width: rendition.width,
      height: rendition.height,
      webpKey,
      webpUrl: storage.publicUrl(webpKey),
      fallbackKey,
      fallbackUrl: storage.publicUrl(fallbackKey),
    });
  }

  // The puts run together rather than in turn. `allSettled` lets every put be
  // attempted even when one fails, and cleanup deletes *every* key the upload
  // could have written rather than only the puts that reported success: a put
  // that rejects may still have landed its object, so deleting by outcome would
  // leak it. Deleting a key that was never written is harmless.
  try {
    const results = await Promise.allSettled(
      objects.map((object) =>
        storage.put(object.key, object.body, object.contentType),
      ),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;

    // `variants` is bound through `jsonbValue` so the column holds a jsonb
    // *array*; `JSON.stringify` here would store one long jsonb string that the
    // site's reader sees as no variants at all.
    const rows = (await db`
      INSERT INTO cms_media
        (id, object_key, content_type, byte_size, width, height, alt, variants,
         created_by)
      VALUES (
        ${id}, ${originalKey}, ${processed.original.contentType},
        ${processed.original.bytes.length}, ${processed.width},
        ${processed.height}, ${alt}, ${jsonbValue(variants)},
        ${input.actorId}
      )
      RETURNING id, object_key, content_type, byte_size, width, height, alt,
                focal_x, focal_y, variants, created_at, updated_at
    `) as unknown as MediaRow[];

    return { ok: true, media: toMedia(rows[0]) };
  } catch (error) {
    // A half-written upload is cleaned up rather than left as orphan objects;
    // a failure here is logged and dropped, because the row is what matters.
    await Promise.all(
      objects.map((object) =>
        storage.delete(object.key).catch((cleanupError) => {
          log.warn(
            "media",
            `Could not clean up ${object.key} after a failed upload: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }),
      ),
    );
    // A bucket or database failure is the editor's problem to retry, not a 500:
    // the controller has no way to recover, so it is turned into a form issue.
    log.error(
      "media",
      `Could not store an upload: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fileIssue("We couldn't save that image. Try again.");
  }
};

export interface ListMediaOptions {
  /**
   * Return at most this many of the newest uploads. Omitted, the whole library
   * is returned (the library page lists everything).
   */
  limit?: number;
}

/**
 * How many uploads one page of the picker's options holds.
 *
 * The value lives in `./limits` so a component and its tests can read it
 * without loading this module; it is re-exported here so the service's surface
 * is unchanged.
 */
export { MEDIA_PICKER_LIMIT };

/**
 * The library, newest first, with every column.
 *
 * The library page lists the whole thing; the pickers take the narrow read
 * below instead. Pass `limit` to page it. `LIMIT NULL` is Postgres for "no
 * limit", so one query serves both shapes.
 */
export const listMedia = async (
  options: ListMediaOptions = {},
): Promise<MediaRecord[]> => {
  const rows = (await db`
    SELECT id, object_key, content_type, byte_size, width, height,
           alt, focal_x, focal_y, variants, created_at, updated_at
    FROM cms_media
    ORDER BY created_at DESC, id DESC
    LIMIT ${options.limit ?? null}
  `) as MediaRow[];
  return rows.map(toMedia);
};

/**
 * One page of the picker's options, newest first.
 *
 * Paging is a keyset cursor rather than `OFFSET`: the library can grow while
 * the picker is open, and an offset would skip or repeat a row when an upload
 * lands between two pages. The cursor is the last row's `created_at` and id —
 * the same pair the ordering uses — encoded so the client treats it as opaque.
 *
 * `q` searches the alt text. `ILIKE` is case-insensitive, and the pattern is
 * escaped so `%` and `_` in a search are the characters the editor typed, not
 * wildcards. The query reads one row past the page to tell whether another
 * page exists without a count.
 */
export const listMediaOptionsPage = async (
  options: MediaOptionsPageOptions = {},
): Promise<MediaOptionsPage> => {
  const limit = options.limit ?? MEDIA_PICKER_LIMIT;
  const q = options.q?.trim() ?? "";
  const pattern = q === "" ? null : `%${escapeLikePattern(q)}%`;
  const cursor = decodeOptionsCursor(options.after ?? null);

  const rows = (await db`
    SELECT id, alt, width, height, variants,
           to_char(created_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
    FROM cms_media
    WHERE TRUE
      ${pattern === null ? db`` : db`AND alt ILIKE ${pattern}`}
      ${
        cursor === null
          ? db``
          : db`AND (created_at, id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`
      }
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `) as MediaOptionRow[];

  const items = rows.slice(0, limit).map(
    ({
      created_at_cursor: _cursor,
      variants,
      ...option
    }): MediaOptionEntry => ({
      ...option,
      variants: parseVariants(variants),
    }),
  );
  const next =
    rows.length > limit ? encodeOptionsCursor(rows[limit - 1]) : null;
  return { items, next };
};

/**
 * The uploads an editor form's image fields currently reference.
 *
 * A block `image` field is drawn from the `{ mediaId }` the stored content
 * already carries, so the form needs the chosen upload's alt, dimensions and
 * variants — and nothing else from the library. The ids come from the same walk
 * over stored values that delete protection uses (`collectMediaIds`); a draft
 * can name anything, so non-UUIDs are dropped before they reach the `uuid`
 * column. Everything is read in one query, however many fields reference an
 * image: a page with a gallery is one read, not one per row.
 *
 * An id with no row is simply absent from the result; the picker draws that as
 * "Upload not found" so the editor knows to replace it, and a save still
 * validates the stored value as before.
 */
export const listPickerImages = async (
  content: unknown,
): Promise<MediaRecord[]> => {
  const ids = filterUuids(collectMediaIds(content));
  if (ids.length === 0) return [];
  const rows = (await db`
    SELECT id, object_key, content_type, byte_size, width, height, alt,
           focal_x, focal_y, variants, created_at, updated_at
    FROM cms_media
    WHERE id IN ${inList(ids)}
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

export type UpdateMediaResult =
  | { ok: true; media: MediaRecord }
  | { ok: false; message: string };

export interface UpdateMediaInput {
  /** The new alt text. Omitted leaves it unchanged. */
  alt?: string;
  /** The new focal point. Omitted leaves it unchanged. */
  focal?: FocalPoint;
}

const clampFraction = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * Update an upload's alt text and focal point, bumping `content_version`.
 *
 * The site's readers cache against `content_version`, so an edit that doesn't
 * bump it keeps serving the old alt and crop. The row write and the bump are
 * one transaction, and a save with both fields to change is one UPDATE and one
 * bump rather than the two of each the separate writes used to cost.
 */
export const updateMedia = async (
  id: string,
  input: UpdateMediaInput,
): Promise<UpdateMediaResult> => {
  let alt: string | null = null;
  if (input.alt !== undefined) {
    const trimmed = input.alt.trim();
    if (trimmed === "") return { ok: false, message: "Enter alt text." };
    if (trimmed.length > MAX_ALT_LENGTH) {
      return {
        ok: false,
        message: `Alt text must be ${MAX_ALT_LENGTH} characters or fewer.`,
      };
    }
    alt = trimmed;
  }

  const focal = input.focal
    ? {
        x: clampFraction(input.focal.x, DEFAULT_FOCAL_POINT.x),
        y: clampFraction(input.focal.y, DEFAULT_FOCAL_POINT.y),
      }
    : null;

  const rows = (await db.begin(async (tx) => {
    const updated = (await tx`
      UPDATE cms_media
         SET alt = COALESCE(${alt}, alt),
             focal_x = COALESCE(${focal?.x ?? null}, focal_x),
             focal_y = COALESCE(${focal?.y ?? null}, focal_y),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ${id}
       RETURNING id, object_key, content_type, byte_size, width, height, alt,
                 focal_x, focal_y, variants, created_at, updated_at
    `) as MediaRow[];

    // Nothing was updated, so there is nothing for the site to re-read.
    if (updated.length === 0) return updated;

    await bumpContentVersion(tx);
    return updated;
  })) as MediaRow[];

  if (rows.length === 0) {
    return { ok: false, message: "That image no longer exists." };
  }
  return { ok: true, media: toMedia(rows[0]) };
};

/** Change an upload's alt text, bumping `content_version`. */
export const updateMediaAlt = (
  id: string,
  alt: string,
): Promise<UpdateMediaResult> => updateMedia(id, { alt });

/** Change an upload's focal point, bumping `content_version`. */
export const updateMediaFocalPoint = (
  id: string,
  focal: FocalPoint,
): Promise<UpdateMediaResult> => updateMedia(id, { focal });

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
}

/**
 * The pages and slots whose published content references this image, plus the
 * pages that use it as their social image.
 *
 * A reference in published content only counts when the revision is live: a
 * draft's reference doesn't put the image on a live page, so deleting it can't
 * break a visitor, and the draft that uses it will re-pick. The match is
 * `jsonb_path_exists` in SQL rather than a walk over every published revision
 * in JavaScript, so only the rows that use the image come back. Pass a
 * transaction to read inside the delete's lock.
 *
 * A page's social image is a settings column, not revision content, and it is
 * live as soon as it is saved — so every page naming the upload counts,
 * published or not. The foreign key would refuse the delete either way; listing
 * the page here is what lets the CMS say which page instead of surfacing a
 * constraint error. `UNION` rather than `UNION ALL` folds a page that uses the
 * image both as its social image and in its content into one row.
 */
export const getMediaUsage = async (
  mediaId: string,
  sql: SQL = db,
): Promise<MediaUsage[]> => {
  const rows = (await sql`
    SELECT 'page' AS kind, p.id, p.title AS label, p.url AS detail
    FROM cms_pages p JOIN cms_revisions r ON r.id = p.published_revision_id
    WHERE jsonb_path_exists(
      r.content, '$.**.mediaId ? (@ == $mediaId)',
      jsonb_build_object('mediaId', ${mediaId}::text))
    UNION
    SELECT 'slot' AS kind, s.id, COALESCE(s.label, s.name) AS label,
           s.name AS detail
    FROM cms_slots s JOIN cms_revisions r ON r.id = s.published_revision_id
    WHERE jsonb_path_exists(
      r.content, '$.**.mediaId ? (@ == $mediaId)',
      jsonb_build_object('mediaId', ${mediaId}::text))
    UNION
    SELECT 'page' AS kind, p.id, p.title AS label, p.url AS detail
    FROM cms_pages p
    WHERE p.social_image_id = ${mediaId}
  `) as UsageRow[];

  return rows.map(({ kind, id, label, detail }) => ({
    kind,
    id,
    label,
    detail,
  }));
};

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "in-use"; usage: MediaUsage[] };

/**
 * Delete an upload, unless a published page or slot still uses it, or a page
 * still names it as its social image.
 *
 * The row is locked `FOR UPDATE`, the usage re-checked and the row deleted in
 * one transaction, so a delete and a publish that references the image can't
 * both win (publish takes `FOR SHARE` on the same rows — `lockReferencedMedia`).
 * The objects are deleted best-effort *after* the commit: a leaked object costs
 * storage, while a row deleted before its objects are gone would leave a live
 * page pointing at a missing file if the delete then failed.
 */
export const deleteMedia = async (
  id: string,
  storage: MediaStorage | null = getMediaStorage(),
): Promise<DeleteMediaResult> => {
  const outcome = await db.begin(async (tx) => {
    const rows = (await tx`
      SELECT id, object_key, content_type, byte_size, width, height, alt,
             focal_x, focal_y, variants, created_at, updated_at
      FROM cms_media WHERE id = ${id} FOR UPDATE
    `) as MediaRow[];
    if (rows.length === 0) return { kind: "not-found" as const };

    const usage = await getMediaUsage(id, tx);
    if (usage.length > 0) return { kind: "in-use" as const, usage };

    await tx`DELETE FROM cms_media WHERE id = ${id}`;
    return { kind: "deleted" as const, media: toMedia(rows[0]) };
  });

  if (outcome.kind === "not-found") return { ok: false, reason: "not-found" };
  if (outcome.kind === "in-use") {
    return { ok: false, reason: "in-use", usage: outcome.usage };
  }

  if (storage) {
    const keys = [
      outcome.media.objectKey,
      ...outcome.media.variants.flatMap((variant) => [
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

  return { ok: true };
};
