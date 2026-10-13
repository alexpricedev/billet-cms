/**
 * `cms_pages` and `cms_redirects`: the pages an editor creates, and the 301s a
 * URL change leaves behind.
 *
 * A page is the CMS's own content, not something a deploy publishes: the site
 * declares page *types* (allowed/required blocks and limits) and the editor
 * builds pages against them. `page_type` is a loose reference to
 * `cms_page_types.name`, the same way `cms_slots.block_name` references
 * `cms_block_types.name`: a page type a deploy drops is marked `removed_at`,
 * never deleted, so a page keeps resolving its type and the CMS can flag it.
 *
 * Content lives in `cms_revisions` like a slot's, and
 * `published_revision_id` points at the revision the site renders. The settings
 * — `url`, `title`, `seo_description`, `social_image` — are columns rather than
 * part of the revision: the spec versions a page's *content*, and a title or a
 * URL is deployment-adjacent metadata the editor expects to change immediately.
 *
 * `social_image` is a URL for now. Phase 6 adds the media library; when it does,
 * a media-backed social image can be added alongside this column rather than
 * replacing it, so a page with a plain URL keeps rendering.
 *
 * `cms_redirects` is what "changing a page's URL writes a 301 from the old URL"
 * means in the database. `from_path` is the old path (unique — one URL resolves
 * one way) and `to_page_id` is the page, not its current URL, so a second
 * rename still resolves: the redirect asks the page where it is now.
 * `ON DELETE CASCADE` is the whole cleanup story — deleting a page removes the
 * redirects that pointed at it, and nothing else.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_pages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_type VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      seo_description TEXT NULL,
      social_image TEXT NULL,
      published_revision_id UUID NULL
        REFERENCES cms_revisions(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // One page per URL, and the lookup the catch-all makes on every request.
  await db`CREATE UNIQUE INDEX cms_pages_url_idx ON cms_pages(url)`;
  await db`CREATE INDEX cms_pages_page_type_idx ON cms_pages(page_type)`;
  await db`
    CREATE INDEX cms_pages_published_revision_id_idx
    ON cms_pages(published_revision_id)
  `;

  await db`
    CREATE TABLE cms_redirects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_path TEXT NOT NULL,
      to_page_id UUID NOT NULL
        REFERENCES cms_pages(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`
    CREATE UNIQUE INDEX cms_redirects_from_path_idx ON cms_redirects(from_path)
  `;
  await db`
    CREATE INDEX cms_redirects_to_page_id_idx ON cms_redirects(to_page_id)
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_redirects`;
  await db`DROP TABLE IF EXISTS cms_pages`;
};
