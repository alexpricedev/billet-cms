import { randomUUID } from "node:crypto";
import { computeHMAC, generateSecureToken } from "../utils/crypto";
import { db } from "./database";
import { createAuthenticatedSession, deleteSession } from "./sessions";

// The platform operator flag. Deliberately a separate axis from any editor or
// teammate role a site exposes through `cms_identities`, so "site admin who is
// not a CMS operator" stays expressible.
export type PlatformRole = "user" | "admin";

export const PLATFORM_ROLES: readonly PlatformRole[] = ["user", "admin"];

export const isPlatformRole = (
  value: string | undefined,
): value is PlatformRole => PLATFORM_ROLES.includes(value as PlatformRole);

export interface User {
  id: string;
  email: string;
  role: PlatformRole;
  created_at: Date;
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

// Every query that selects a user goes through this, so a row from the driver
// can never reach a template with a timestamp still typed as a string.
export const toUser = (row: {
  id: string;
  email: string;
  role: PlatformRole;
  created_at: string | Date;
}): User => ({
  id: row.id,
  email: row.email,
  role: row.role,
  created_at: new Date(row.created_at),
});

/**
 * Look up a user by email without creating one.
 */
export const findUserByEmail = async (email: string): Promise<User | null> => {
  const normalizedEmail = email.toLowerCase().trim();

  const results = await db`
    SELECT id, email, role, created_at
    FROM cms_users
    WHERE email = ${normalizedEmail}
  `;

  return results.length > 0 ? toUser(results[0]) : null;
};

/**
 * Create or get an existing user by email.
 *
 * Phase 1 ships Billet's scaffold, so the CMS still owns a `cms_users` table
 * for its magic-link sign-in. Phase 3 moves sign-in onto the site's own
 * accounts through `cms_identities` and drops this function.
 */
export const findOrCreateUser = async (email: string): Promise<User> => {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await findUserByEmail(normalizedEmail);
  if (existing) return existing;

  const userId = randomUUID();
  const newUser = await db`
    INSERT INTO cms_users (id, email)
    VALUES (${userId}, ${normalizedEmail})
    RETURNING id, email, role, created_at
  `;

  return toUser(newUser[0]);
};

/**
 * Mint a single-use token for a user and return the raw value.
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
 * Consume a token of a given type, returning the user it belongs to.
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
 * Create a magic link token for a user, creating the account on first use.
 */
export const createMagicLink = async (
  email: string,
): Promise<{ user: User; rawToken: string }> => {
  const user = await findOrCreateUser(email);
  const rawToken = await createUserToken(user.id, "magic_link");

  return { user, rawToken };
};

/**
 * Verify a magic link token and consume it, then mint a session.
 *
 * The atomic UPDATE inside `consumeUserToken` is what prevents races: only an
 * unused, unexpired token is claimed.
 */
export const verifyMagicLink = async (
  rawToken: string,
  previousSessionId?: string | null,
): Promise<AuthResult> => {
  const userId = await consumeUserToken(rawToken, "magic_link");

  if (!userId) {
    return { success: false, error: "Invalid or expired token" };
  }

  const userResults = await db`
    SELECT id, email, role, created_at
    FROM cms_users
    WHERE id = ${userId}
  `;

  if (userResults.length === 0) {
    return { success: false, error: "User not found" };
  }

  const sessionId = await regenerateSession(userId, previousSessionId);

  return { success: true, user: toUser(userResults[0]), sessionId };
};

/**
 * Delete expired rows from the CMS's own auth tables.
 *
 * Not a correctness measure — every read filters `expires_at` — but it keeps
 * guest sessions and spent token hashes from accumulating.
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
    DELETE FROM cms_sessions
    WHERE expires_at < CURRENT_TIMESTAMP
  `;
};
