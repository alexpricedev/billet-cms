/**
 * `cms_block_types`: the block types a site publishes on deploy.
 *
 * One row per block a site declares. `json_schema` is the Zod schema flattened
 * to JSON Schema (what the plugin validates stored content against);
 * `fields` is the field metadata tree the CMS builds its form from; and
 * `schema_hash` lets the next deploy tell an unchanged definition from a
 * changed one without comparing JSONB document by document.
 *
 * `removed_at` is set, never deleted, when a deploy no longer declares a block
 * (Q4): saved content keeps pointing at the row, and the CMS can flag it.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_block_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL UNIQUE,
      json_schema JSONB NOT NULL,
      fields JSONB NOT NULL,
      schema_hash TEXT NOT NULL,
      removed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`CREATE INDEX cms_block_types_removed_at_idx ON cms_block_types(removed_at)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_block_types`;
};
