/**
 * Drop `cms_handoff_tokens_user_id_idx`.
 *
 * Migration 009 created the index with the table, but nothing reads handoff
 * tokens by `user_id`: the CMS claims one by `token_hash`, and the cleanup sweep
 * deletes by `expires_at`. A table whose rows live for 60 seconds does not need
 * a write-only index on a column no query filters, so remove it.
 *
 * `cms_handoff_tokens_expires_at_idx` stays — the sweep filters on `expires_at`.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`DROP INDEX IF EXISTS cms_handoff_tokens_user_id_idx`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`CREATE INDEX IF NOT EXISTS cms_handoff_tokens_user_id_idx ON cms_handoff_tokens(user_id)`;
};
