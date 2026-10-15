/**
 * The Postgres advisory-lock keys the CMS takes at boot.
 *
 * Every lock is taken in one namespace — the first key is
 * `hashtext("billet-cms")` — so the locks this app holds are recognisable
 * together in `pg_locks` and cannot collide with another app sharing the
 * database. Deriving the first key from a named string rather than a hand-picked
 * integer is what keeps the namespace from colliding by accident. The second key
 * picks the lock within the namespace: 1 while the migrations run, 2 around the
 * identity-view check.
 *
 * The namespace is bound as a string and hashed in SQL; it must not be replaced
 * with a JS number, which would hash to a different key.
 *
 * Kept in its own module, with no database import, so a test can hold the same
 * lock the code takes and `identity-view.ts` can import the namespace without
 * constructing the server's pool.
 */
export const LOCK_NAMESPACE = "billet-cms";

/** The migration lock's subkey within {@link LOCK_NAMESPACE}. */
export const MIGRATION_LOCK_SUBKEY = 1;

/** The identity-view lock's subkey within {@link LOCK_NAMESPACE}. */
export const IDENTITY_VIEW_LOCK_SUBKEY = 2;
