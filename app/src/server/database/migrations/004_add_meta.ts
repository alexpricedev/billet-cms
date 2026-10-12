/**
 * `cms_meta`: the contract version and the content version.
 *
 * One row, enforced by the primary key and its CHECK. `contract_version` is
 * written by the CMS at boot so a site's publish step can refuse to write
 * against an incompatible CMS. `content_version` is bumped whenever published
 * content changes; the plugin polls it to invalidate its in-memory cache within
 * seconds instead of waiting for a TTL.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_meta (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      contract_version TEXT NOT NULL,
      content_version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_meta`;
};
