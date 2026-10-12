import { TABLES } from "@alexpricedev/billet-cms/contract";
import type { SQL } from "bun";
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
 * `role` (`'admin'` is the default filter). Postgres refuses to drop or retype a
 * column a view depends on, so a site migration that changes any of them must
 * `DROP VIEW cms_identities` first; the CMS rebuilds this default on its next
 * boot. A site that wants a different definition — a renamed column, or editor
 * roles beyond admins — creates that view in the same migration, and the CMS
 * leaves it alone from then on.
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
 *    editor roles. Existence is `to_regclass` against `current_schema()`, so any
 *    relation under that name — a view, or a site that replaced it with a table —
 *    counts as present, and the check is scoped to the schema the CMS creates in
 *    rather than wherever the session's `search_path` happens to point.
 * 2. **Skip when the site's `users` table isn't there yet.** The CMS is
 *    deployed before the site, and creating a view over a table that doesn't
 *    exist is an error. Boot proceeds without it; the next boot after the
 *    site's first deploy creates it.
 *
 * A site migration that drops or retypes `users.id`, `users.email` or
 * `users.role` has to `DROP VIEW cms_identities` first, because Postgres refuses
 * the change while the view depends on the column. That drop is the whole
 * signal: the next boot finds no view, takes rule 1's create path and rebuilds
 * the default. A site that had replaced the default with its own definition must
 * recreate that definition in the same migration, or the next boot rebuilds the
 * admin-only default in its place.
 */
export const ensureIdentitiesView = async (sql?: SQL): Promise<void> => {
  // Default to the app's pool, imported lazily so a test helper can create the
  // view against its own connection without constructing the server's.
  const target = sql ?? (await import("../services/database")).db;

  await target.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${IDENTITY_VIEW_LOCK_KEY}::bigint)`;

    const existing = await tx`
      SELECT to_regclass(
        current_schema() || '.' || ${TABLES.identities}
      ) AS relation
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
