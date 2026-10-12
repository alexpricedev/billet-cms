import { randomUUID } from "node:crypto";
import { TABLES } from "@alexpricedev/billet-cms/contract";
import { computeHMAC, generateSecureToken } from "../utils/crypto";
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

export interface UserToken {
  id: string;
  user_id: string;
  token_hash: string;
  type: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

// The `type` discriminator on cms_user_tokens. Magic link is the only flow the
// scaffold ships; the column keeps a place for a second one without a new table.
export type UserTokenType = "magic_link";

const MINUTE_MS = 60 * 1000;

const TOKEN_TTL_MS: Record<UserTokenType, number> = {
  // Short: the link both authenticates and signs in, so a leaked mailbox is a
  // live session.
  magic_link: 15 * MINUTE_MS,
};

// What the email carrying the token tells the recipient. Derived from the
// lifetime above rather than restated, so the copy can't promise an expiry the
// token doesn't have.
export const MAGIC_LINK_EXPIRY_MINUTES = TOKEN_TTL_MS.magic_link / MINUTE_MS;

export type AuthResult =
  | { success: true; user: User; sessionId: string }
  | { success: false; error: string };

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

/**
 * Look up an identity by email without creating one.
 *
 * Reads `cms_identities`, the site's view. An email the view doesn't expose — a
 * non-admin under the default view, or someone with no site account — is `null`
 * and stays `null`: the CMS never writes the site's `users` table.
 */
export const findUserByEmail = async (email: string): Promise<User | null> => {
  const normalizedEmail = email.toLowerCase().trim();

  const results = (await db.unsafe(
    `SELECT id, email, role FROM ${TABLES.identities} WHERE email = $1`,
    [normalizedEmail],
  )) as IdentityRow[];

  return results.length > 0 ? toUser(results[0]) : null;
};

/** Look up an identity by id, for a session whose user is no longer an editor. */
export const findUserById = async (id: string): Promise<User | null> => {
  const results = (await db.unsafe(
    `SELECT id, email, role FROM ${TABLES.identities} WHERE id = $1`,
    [id],
  )) as IdentityRow[];

  return results.length > 0 ? toUser(results[0]) : null;
};

/**
 * Mint a single-use token for an identity and return the raw value.
 *
 * Only the HMAC of the token is stored, so a database dump can't be replayed as
 * a login — the raw value exists only in the email that carries it.
 */
export const createUserToken = async (
  userId: string,
  type: UserTokenType,
): Promise<string> => {
  const rawToken = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[type]);

  await db`
    INSERT INTO cms_user_tokens (id, user_id, token_hash, type, expires_at)
    VALUES (
      ${randomUUID()},
      ${userId},
      ${computeHMAC(rawToken)},
      ${type},
      ${expiresAt.toISOString()}
    )
  `;

  return rawToken;
};

/**
 * Consume a token of a given type, returning the identity id it belongs to.
 *
 * The single UPDATE ... RETURNING is what makes this race-safe: two concurrent
 * requests with the same token both try to claim the row, and only the one that
 * flips used_at from NULL gets a row back. Type is part of the WHERE clause, so
 * one flow's token can never be spent as another's.
 */
export const consumeUserToken = async (
  rawToken: string,
  type: UserTokenType,
): Promise<string | null> => {
  const results = await db`
    UPDATE cms_user_tokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE type = ${type}
      AND token_hash = ${computeHMAC(rawToken)}
      AND used_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING user_id
  `;

  return results.length > 0 ? (results[0].user_id as string) : null;
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
 * Create a magic-link token for an email `cms_identities` exposes, or `null` for
 * an email it does not.
 *
 * Sign-in is invite-only: an unknown address — or one the site's view keeps out
 * — gets no token and no email, and nothing is ever written to the site's
 * `users` table. The caller still shows the same "check your email" page it
 * shows a known address, so the form can't be used to enumerate accounts.
 */
export const createMagicLink = async (
  email: string,
): Promise<{ user: User; rawToken: string } | null> => {
  const user = await findUserByEmail(email);

  if (!user) return null;

  const rawToken = await createUserToken(user.id, "magic_link");

  return { user, rawToken };
};

/**
 * Verify a magic link token and consume it, then mint a session.
 *
 * The atomic UPDATE inside `consumeUserToken` is what prevents races: only an
 * unused, unexpired token is claimed. The identity is then re-read from the
 * view, so a token minted before the site removed the account no longer signs
 * anyone in.
 */
export const verifyMagicLink = async (
  rawToken: string,
  previousSessionId?: string | null,
): Promise<AuthResult> => {
  const userId = await consumeUserToken(rawToken, "magic_link");

  if (!userId) {
    return { success: false, error: "Invalid or expired token" };
  }

  const user = await findUserById(userId);

  if (!user) {
    return { success: false, error: "User not found" };
  }

  const sessionId = await regenerateSession(userId, previousSessionId);

  return { success: true, user, sessionId };
};

/**
 * Delete expired rows from the CMS's own auth tables.
 *
 * Not a correctness measure — every read filters `expires_at` — but it keeps
 * guest sessions, spent token hashes and handoff tokens from accumulating.
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
    DELETE FROM cms_sessions
    WHERE expires_at < CURRENT_TIMESTAMP
  `;
};
