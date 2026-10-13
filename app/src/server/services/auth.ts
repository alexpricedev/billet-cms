import { TABLES } from "@alexpricedev/billet-cms/contract";
import { db } from "./database";
import { createAuthenticatedSession, deleteSession } from "./sessions";

/**
 * A CMS user: one row of `cms_identities`.
 *
 * The CMS does not own accounts. This is a site user the CMS is allowed to sign
 * in, read through the view the site defines (the default exposes its admins).
 * `role` is whatever the view exposes — the default leaves it `'admin'`, and a
 * site that widens the view can add editor roles without the CMS knowing them.
 */
export interface User {
  id: string;
  email: string;
  role: string;
}

interface IdentityRow {
  id: string;
  email: string;
  role: string;
}

// Every query that selects an identity goes through this, so a row from the
// driver can never reach a template with a column missing its shape.
const toUser = (row: IdentityRow): User => ({
  id: row.id,
  email: row.email,
  role: row.role,
});

/** Look up an identity by id, for a session whose user is no longer an editor. */
export const findUserById = async (id: string): Promise<User | null> => {
  const results = (await db.unsafe(
    `SELECT id, email, role FROM ${TABLES.identities} WHERE id = $1`,
    [id],
  )) as IdentityRow[];

  return results.length > 0 ? toUser(results[0]) : null;
};

/**
 * Issue a fresh authenticated session, discarding whatever the request arrived
 * with.
 *
 * Every sign-in path calls this instead of createAuthenticatedSession directly:
 * reusing the id an anonymous visitor arrived with would let an attacker who
 * planted that cookie ride the session once it gains privileges. Deleting an id
 * that no longer exists is a no-op.
 */
export const regenerateSession = async (
  userId: string,
  previousSessionId?: string | null,
): Promise<string> => {
  if (previousSessionId) {
    await deleteSession(previousSessionId);
  }

  return createAuthenticatedSession(userId);
};

/**
 * Delete expired rows from the CMS's own auth tables.
 *
 * Not a correctness measure — every read filters `expires_at` — but it keeps
 * spent handoff tokens and guest sessions from accumulating.
 *
 * Called on a timer by `startCleanupSweep`; safe to run concurrently with
 * anything, and safe to run twice.
 */
export const cleanupExpired = async (): Promise<void> => {
  await db`
    DELETE FROM cms_user_tokens
    WHERE expires_at < CURRENT_TIMESTAMP
  `;

  await db`
    DELETE FROM cms_handoff_tokens
    WHERE expires_at < CURRENT_TIMESTAMP
  `;

  await db`
    DELETE FROM cms_preview_tokens
    WHERE expires_at < CURRENT_TIMESTAMP
  `;

  await db`
    DELETE FROM cms_sessions
    WHERE expires_at < CURRENT_TIMESTAMP
  `;
};
