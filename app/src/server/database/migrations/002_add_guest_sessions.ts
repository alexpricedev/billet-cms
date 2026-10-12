/**
 * Guest sessions and per-session CSRF secrets.
 *
 * A visitor without a session gets a guest row so a signed-out form has
 * something to bind its CSRF token to, and `session_type` distinguishes those
 * from the authenticated sessions a sign-in mints. Both columns land here
 * rather than in the initial migration so the shape of the scaffold's history
 * stays legible.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_sessions
    ADD COLUMN csrf_secret TEXT NULL
  `;

  await db`
    ALTER TABLE cms_sessions
    ADD COLUMN session_type VARCHAR(20) NOT NULL DEFAULT 'authenticated'
  `;

  await db`
    ALTER TABLE cms_sessions
    ALTER COLUMN user_id DROP NOT NULL
  `;

  await db`CREATE INDEX cms_sessions_csrf_secret_idx ON cms_sessions(csrf_secret) WHERE csrf_secret IS NOT NULL`;
  await db`CREATE INDEX cms_sessions_session_type_idx ON cms_sessions(session_type)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DELETE FROM cms_sessions WHERE session_type = 'guest'`;
  await db`DROP INDEX IF EXISTS cms_sessions_session_type_idx`;
  await db`DROP INDEX IF EXISTS cms_sessions_csrf_secret_idx`;
  await db`ALTER TABLE cms_sessions ALTER COLUMN user_id SET NOT NULL`;
  await db`ALTER TABLE cms_sessions DROP COLUMN IF EXISTS session_type`;
  await db`ALTER TABLE cms_sessions DROP COLUMN IF EXISTS csrf_secret`;
};
