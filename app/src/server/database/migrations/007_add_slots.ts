/**
 * `cms_slots`: the slots a site's templates declare.
 *
 * A slot is a named hole in a template — `slot("home.hero", hero)` — filled by
 * one block type. Publishing writes one row per slot, so the CMS can list them
 * by page (`page` is the name's first segment unless the site overrides it) and
 * know which block's form to build.
 *
 * Like block and page types, a slot a deploy no longer declares is marked
 * `removed_at`, never deleted, so saved content keeps its target.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_slots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL UNIQUE,
      block_name VARCHAR(255) NOT NULL,
      page VARCHAR(255) NOT NULL,
      label TEXT NULL,
      help TEXT NULL,
      removed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`CREATE INDEX cms_slots_removed_at_idx ON cms_slots(removed_at)`;
  await db`CREATE INDEX cms_slots_block_name_idx ON cms_slots(block_name)`;
  await db`CREATE INDEX cms_slots_page_idx ON cms_slots(page)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_slots`;
};
