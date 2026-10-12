/**
 * `cms_page_types`: the page types a site publishes on deploy.
 *
 * A page type says which blocks a page may contain (`allowed_blocks`), which it
 * must (`required_blocks`) and any per-block limits (`block_limits`, e.g.
 * `{"hero": {"max": 1, "position": "top"}}`). `json_schema` is the allowed
 * blocks as a discriminated array, used to validate a page's content.
 *
 * The three lists are JSONB rather than Postgres arrays so the publish step can
 * bind them as plain JSON without the driver reshaping them, and because the
 * limits are structured anyway.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_page_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL UNIQUE,
      label TEXT NULL,
      help TEXT NULL,
      allowed_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
      required_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
      block_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
      json_schema JSONB NOT NULL,
      schema_hash TEXT NOT NULL,
      removed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`CREATE INDEX cms_page_types_removed_at_idx ON cms_page_types(removed_at)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_page_types`;
};
