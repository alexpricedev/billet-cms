/**
 * `cms_revisions_restored_from_idx`: lets the `ON DELETE SET NULL` on
 * `restored_from` find the rows pointing at a deleted revision without
 * scanning the table.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE INDEX cms_revisions_restored_from_idx
    ON cms_revisions(restored_from)
    WHERE restored_from IS NOT NULL
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP INDEX IF EXISTS cms_revisions_restored_from_idx`;
};
