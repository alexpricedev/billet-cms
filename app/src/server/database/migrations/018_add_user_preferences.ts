/**
 * `cms_user_preferences`: the settings an editor keeps across devices.
 *
 * The first is `theme` — Light, Dark or System — chosen on the account page.
 * It lives here rather than on a users table because the CMS has none:
 * `cms_users` was dropped in 009 and `users` belongs to the site, which the CMS
 * must never write. `user_id` names an identity, so like `cms_sessions.user_id`
 * there is no foreign key: the view's rows belong to the site.
 *
 * One row per person, created on the first save. `system` is the default and
 * the behaviour when no row exists; the CHECK refuses anything else, so a
 * hand-edited value or an unknown theme from a newer build can never be stored.
 * Additive, so `CONTRACT_VERSION` stays: an older CMS ignores the table.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_user_preferences (
      user_id UUID PRIMARY KEY,
      theme TEXT NOT NULL DEFAULT 'system'
        CONSTRAINT cms_user_preferences_theme_check
        CHECK (theme IN ('light', 'dark', 'system')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_user_preferences`;
};
