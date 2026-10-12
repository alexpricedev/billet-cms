import { TABLES } from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
import { db } from "../services/database";
import { log } from "../services/logger";

// Taken around the check-and-create so two instances booting at once cannot
// both decide the view is missing. A different key from the migration lock, so
// the two never wait on each other.
const IDENTITY_VIEW_LOCK_KEY = "8041000002";

/**
 * The default definition of the CMS's identity view.
 *
 * The CMS does not own user accounts: it reads them through `cms_identities`,
 * a view over the site's own `users` table. The default exposes the site's
 * admins, which is the smallest useful set; a site that wants editors replaces
 * the view in its own migration.
 *
 * The default pins three columns of the site's `users` table: `id` (keyed on,
 * and the view's own column of the same name), `email` (sign-in identity) and
 * `role` (`'admin'` is the default filter). A site that renames or drops any of
 * them must replace this view rather than rely on the default.
 */
const DEFAULT_IDENTITY_VIEW_QUERY = `SELECT id, email, role
  FROM users
  WHERE role = 'admin'`;

/**
 * Create `cms_identities` if it is missing, and never touch it otherwise.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Create only if missing.** The site owns this view's definition. Running
 *    `CREATE OR REPLACE` on every boot would silently discard a site's custom
 *    editor roles. Existence is `to_regclass`, so any relation under that name —
 *    a view, or a site that replaced it with a table — counts as present.
 * 2. **Skip when the site's `users` table isn't there yet.** The CMS is
 *    deployed before the site, and creating a view over a table that doesn't
 *    exist is an error. Boot proceeds without it; the next boot after the
 *    site's first deploy creates it.
 */
export const ensureIdentitiesView = async (sql: SQL = db): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${IDENTITY_VIEW_LOCK_KEY}::bigint)`;

    const existing = await tx`
      SELECT to_regclass(${TABLES.identities}) AS relation
    `;
    if ((existing[0] as { relation: string | null } | undefined)?.relation) {
      return;
    }

    const siteUsers = await tx`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'users'
    `;
    if (siteUsers.length === 0) {
      log.info(
        "identities",
        `${TABLES.identities} skipped: no site 'users' table yet`,
      );
      return;
    }

    // `unsafe` is the only way to run DDL whose identifier isn't a bind
    // parameter. Both fragments are module constants, not user input.
    await tx.unsafe(
      `CREATE VIEW ${TABLES.identities} AS ${DEFAULT_IDENTITY_VIEW_QUERY}`,
    );
    log.info("identities", `Created ${TABLES.identities} view`);
  });
};
