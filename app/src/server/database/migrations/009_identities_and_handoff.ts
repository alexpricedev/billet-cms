/**
 * The handoff tokens, and the end of `cms_users`.
 *
 * The CMS no longer owns accounts: sign-in looks a person up in
 * `cms_identities`, the view over the site's own `users`, and a session stores
 * that site user's id. `cms_users` (and the two foreign keys onto it) is
 * dropped; `cms_sessions.user_id` and `cms_user_tokens.user_id` keep their
 * columns but now name an identity. There is no foreign key, because
 * `cms_identities` is a view — the site owns the rows behind it.
 *
 * `cms_handoff_tokens` is the other half of the Edit content link: the site's
 * plugin mints a row (a hashed, 60-second, single-use token) and the CMS spends
 * it to start that admin's session. It is the one thing both services write to
 * without an API between them.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_handoff_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`CREATE INDEX cms_handoff_tokens_user_id_idx ON cms_handoff_tokens(user_id)`;
  await db`CREATE INDEX cms_handoff_tokens_expires_at_idx ON cms_handoff_tokens(expires_at)`;

  // `cms_users` is going away, so the columns that referenced it become loose
  // identity references. Drop the constraints first: Postgres refuses the table
  // drop while they depend on it.
  await db`ALTER TABLE cms_sessions DROP CONSTRAINT IF EXISTS cms_sessions_user_id_fkey`;
  await db`ALTER TABLE cms_user_tokens DROP CONSTRAINT IF EXISTS cms_user_tokens_user_id_fkey`;
  await db`DROP TABLE IF EXISTS cms_users`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS cms_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      role VARCHAR(20) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin'))
    )
  `;

  // The columns name identities from the site's `users`, and the recreated
  // `cms_users` is empty, so any row still carrying a `user_id` would violate
  // the foreign key that is about to be added. Delete those first; guest
  // sessions (a null `user_id`) are unaffected and survive the rollback.
  await db`DELETE FROM cms_sessions WHERE user_id IS NOT NULL`;
  await db`DELETE FROM cms_user_tokens WHERE user_id IS NOT NULL`;

  await db`
    ALTER TABLE cms_sessions
    ADD CONSTRAINT cms_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES cms_users(id) ON DELETE CASCADE
  `;
  await db`
    ALTER TABLE cms_user_tokens
    ADD CONSTRAINT cms_user_tokens_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES cms_users(id) ON DELETE CASCADE
  `;
  await db`DROP TABLE IF EXISTS cms_handoff_tokens`;
};
