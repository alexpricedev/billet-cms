/**
 * `cms_block_types.label`: the human name a block is shown by.
 *
 * A block's `name` is a developer slug (`fullImage`, `ctaBanner`): stable, and
 * what stored content and the site's code refer to. The `label` is the words an
 * editor sees ("Full-width image"), declared on `block()` and published with
 * the rest of the stored schema. Required, so it is NOT NULL, with an empty
 * default so existing rows from an older publish keep their place: nothing
 * reads an empty label as "use the slug", and the contract version check
 * refuses an old site until it republishes with labels (Q2).
 *
 * A column on an existing table, not a new relation, so the only `cms_` object
 * the migration adds is the table's own column.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_block_types
      ADD COLUMN label TEXT NOT NULL DEFAULT ''
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_block_types DROP COLUMN IF EXISTS label`;
};
