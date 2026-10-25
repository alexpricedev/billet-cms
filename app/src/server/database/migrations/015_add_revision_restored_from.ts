/**
 * `cms_revisions.restored_from`: the revision a restore copied.
 *
 * A restore appends a fresh revision with the old content, which history could
 * not tell apart from an ordinary save. The restore now records its source, so
 * the row can say "Restored from 11 Jan 2026". Nullable: ordinary saves and
 * restores made before this have no source. `ON DELETE SET NULL` keeps the
 * revision if its source is ever removed. Older readers ignore the column, so
 * `CONTRACT_VERSION` stays.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_revisions
      ADD COLUMN restored_from UUID NULL
      CONSTRAINT cms_revisions_restored_from_fkey
      REFERENCES cms_revisions(id) ON DELETE SET NULL
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_revisions DROP COLUMN IF EXISTS restored_from`;
};
