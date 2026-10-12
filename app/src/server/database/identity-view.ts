import { TABLES } from "@alexpricedev/billet-cms/contract";
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
 * Only the columns sign-in needs: an id to key a session on, an email to
 * identify with, and a role to gate on.
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
 *    editor roles.
 * 2. **Skip when the site's `users` table isn't there yet.** The CMS is
 *    deployed before the site, and creating a view over a table that doesn't
 *    exist is an error. Boot proceeds without it; the next boot after the
 *    site's first deploy creates it.
 */
export const ensureIdentitiesView = async (): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${IDENTITY_VIEW_LOCK_KEY}::bigint)`;

    const existing = await tx`
      SELECT 1 FROM pg_views
      WHERE schemaname = current_schema()
        AND viewname = ${TABLES.identities}
    `;
    if (existing.length > 0) return;

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
