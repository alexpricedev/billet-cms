/**
 * `cms_media`, the uploads library.
 *
 * One row per stored image. An `image()` field stores only a `mediaId`, so the
 * site reads this row through the plugin's `<CmsImage>` to get the picture's
 * dimensions, its `srcset` and its `object-position`; nothing about the file
 * itself lives in the content.
 *
 * `object_key` names the metadata-stripped original in the bucket, and
 * `variants` holds the JSONB rendition list (the WebP and fallback object keys
 * and public URLs at each width). Both keys and URLs are stored rather than
 * derived, so the site needs no bucket configuration and the later export
 * carries working URLs with the rows.
 *
 * `alt` is `NOT NULL` but its emptiness is the service's job: an empty string
 * is a valid SQL value and a useless alt, so the write layer refuses a blank
 * one and this only rules out "no alt at all".
 *
 * `focal_x`/`focal_y` are fractions from 0 to 1, checked here so a hand-edited
 * row can't push `object-position` off the image; the default is the centre.
 * `created_by` is a loose reference to an identity — no foreign key, because
 * the view's rows belong to the site.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_media (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      object_key TEXT NOT NULL,
      content_type VARCHAR(100) NOT NULL,
      byte_size BIGINT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      alt TEXT NOT NULL,
      focal_x REAL NOT NULL DEFAULT 0.5 CHECK (focal_x >= 0 AND focal_x <= 1),
      focal_y REAL NOT NULL DEFAULT 0.5 CHECK (focal_y >= 0 AND focal_y <= 1),
      variants JSONB NOT NULL,
      created_by UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // The uploads library lists newest first; this is the only read that isn't
  // by primary key.
  await db`
    CREATE INDEX cms_media_created_at_idx ON cms_media(created_at DESC)
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_media`;
};
