/**
 * The user type templates read.
 *
 * Kept as its own module because every server template imports `User` from
 * here. A CMS user is a row of the site's `cms_identities` view (see
 * `./auth`); there is no `cms_users` table and no user administration — the
 * site owns accounts, and this app only signs them in.
 */
export type { User } from "./auth";
