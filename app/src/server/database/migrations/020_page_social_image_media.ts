/**
 * `cms_pages.social_image` becomes `social_image_id`, a reference into the
 * media library.
 *
 * The column was a pasted URL because the library did not exist yet; 010's
 * comment said it would move once it did. It now names a `cms_media` row and
 * the plugin resolves the upload's renditions when it builds the share card.
 * The old URL values are dropped rather than migrated: there is no way to turn
 * an arbitrary address into an upload, and none of this is in production.
 *
 * The foreign key is the backstop for delete protection. The CMS refuses to
 * delete an upload that a page uses (`getMediaUsage`); the FK means a row that
 * check missed cannot leave a page pointing at nothing. It is left at the
 * default NO ACTION, so Postgres refuses the delete rather than silently
 * clearing the page's image.
 *
 * The index is the other half of that lookup: Postgres does not index a
 * foreign key by itself, and "which pages use this upload?" is the one read
 * that is not by the page's own key.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_pages
      DROP COLUMN social_image,
      ADD COLUMN social_image_id UUID NULL
        REFERENCES cms_media(id)
  `;

  await db`
    CREATE INDEX cms_pages_social_image_id_idx
    ON cms_pages(social_image_id)
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP INDEX IF EXISTS cms_pages_social_image_id_idx`;
  await db`
    ALTER TABLE cms_pages
      DROP COLUMN IF EXISTS social_image_id,
      ADD COLUMN social_image TEXT NULL
  `;
};
