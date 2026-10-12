/**
 * The platform operator flag on `cms_users`.
 *
 * `user` or `admin`, deliberately narrow. Teammate and editor roles for the CMS
 * live in the site's own identity view (`cms_identities`), not here, so this
 * axis never grows to hold them.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_users
    ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin'))
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_users DROP COLUMN role`;
};
