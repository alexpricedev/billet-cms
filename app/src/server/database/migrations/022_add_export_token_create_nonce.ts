/**
 * `cms_export_tokens.create_nonce_hash`: the one-use code a create form carries.
 *
 * A raw export token exists only in the response that creates it, so reloading
 * that response re-posts the form and mints a second token. The create form
 * carries a random nonce and its row stores the nonce's HMAC; the unique index
 * is what refuses the replay, because the second insert lands on a value that
 * is already there.
 *
 * The HMAC, not the nonce, follows the rule the token hash already does: a
 * database dump yields nothing that can be replayed. NULL is allowed and the
 * index ignores it, so rows written before this migration — and any caller that
 * does not go through the admin form — keep working.
 *
 * A separately named unique index, not a UNIQUE column constraint, for the
 * reason 017 gives: a constraint's implicit index would be
 * `cms_export_tokens_create_nonce_hash_key`, and every index the CMS creates
 * ends in `_idx`. The service catches the violation by that index name.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_export_tokens
      ADD COLUMN create_nonce_hash TEXT NULL
  `;
  await db`
    CREATE UNIQUE INDEX cms_export_tokens_create_nonce_hash_idx
    ON cms_export_tokens(create_nonce_hash)
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP INDEX IF EXISTS cms_export_tokens_create_nonce_hash_idx`;
  await db`
    ALTER TABLE cms_export_tokens DROP COLUMN IF EXISTS create_nonce_hash
  `;
};
