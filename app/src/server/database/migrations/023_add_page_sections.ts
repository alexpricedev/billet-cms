/**
 * `cms_page_sections`: the sections a site's config declares by URL pattern.
 *
 * A section is a named group of pages — "Case studies", "Journal" — declared as
 * `section("journal", { paths: ["/journal", "/journal/**"] })` and written here
 * by a deploy's publish, the same way block types, page types and slots are.
 * The Pages list groups its rows under each section's label in config order,
 * then falls back to page types for pages that match no section, so an editor
 * on a site with dozens of pages can find one without scanning the list.
 *
 * `paths` holds the patterns verbatim as a JSONB array: the declaration has
 * already refused anything that isn't a same-origin path, and the matcher is
 * what gives `*` (one segment) and `**` (any number) their meaning, so the
 * column keeps what the site wrote rather than a compiled form an older CMS
 * could misread. `position` is the index in the site's `sections` array, which
 * is what orders the groups.
 *
 * Like the other published kinds, a section a deploy no longer declares is
 * marked `removed_at` rather than deleted, and a redeclared one is restored by
 * the publish that finds it again. Contract version 0.12.0 is the Phase 12 bump
 * that goes with this table: an older CMS cannot store a newer site's sections.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_page_sections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL UNIQUE,
      label TEXT NULL,
      paths JSONB NOT NULL,
      position INTEGER NOT NULL,
      removed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // The Pages list reads every live section, in config order. A removed one is
  // ignored there, but the publish step still looks it up by name to restore
  // it, so `name` carries the unique index.
  await db`
    CREATE INDEX cms_page_sections_removed_at_idx
    ON cms_page_sections(removed_at)
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_page_sections`;
};
