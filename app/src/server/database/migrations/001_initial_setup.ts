/**
 * Initial database setup.
 *
 * Creates the tables the CMS owns outright. Every table here is `cms_`-prefixed
 * so a CMS instance can share a database with the site it serves: the site's
 * own `users`, `sessions`, `migrations` and so on keep their names and neither
 * service can clobber the other's.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`
    CREATE TABLE cms_sessions (
      id_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      last_activity_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`
    CREATE TABLE cms_user_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      type VARCHAR(50) NOT NULL DEFAULT 'magic_link',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db`CREATE INDEX idx_cms_sessions_user_id ON cms_sessions(user_id)`;
  await db`CREATE INDEX idx_cms_sessions_expires_at ON cms_sessions(expires_at)`;
  await db`CREATE INDEX idx_cms_sessions_last_activity ON cms_sessions(last_activity_at)`;
  await db`CREATE INDEX idx_cms_user_tokens_user_id ON cms_user_tokens(user_id)`;
  await db`CREATE INDEX idx_cms_user_tokens_type ON cms_user_tokens(type)`;
  await db`CREATE INDEX idx_cms_user_tokens_expires_at ON cms_user_tokens(expires_at)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_user_tokens`;
  await db`DROP TABLE IF EXISTS cms_sessions`;
  await db`DROP TABLE IF EXISTS cms_users`;
};
