import { randomUUID } from "node:crypto";
import { TABLES } from "@alexpricedev/billet-cms/contract";
import type { BunRequest } from "bun";
import { computeHMAC } from "../utils/crypto";
import {
  type DatabaseMutationResult,
  hasAffectedRows,
} from "../utils/database";
import type { User } from "./auth";
import { db } from "./database";

export type SessionType = "guest" | "authenticated";

export interface SessionContext {
  sessionId: string | null;
  sessionHash: string | null;
  sessionType: SessionType | null;
  user: User | null;
  isGuest: boolean;
  isAuthenticated: boolean;
  requiresSetCookie: boolean;
}

const GUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;
const AUTH_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "cms_session";
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 30 * 24 * 60 * 60,
};

export const getSessionIdFromRequest = (req: BunRequest): string | null => {
  return req.cookies.get(SESSION_COOKIE_NAME) || null;
};

export const setSessionCookie = (
  req: BunRequest,
  rawSessionId: string,
): void => {
  req.cookies.set(SESSION_COOKIE_NAME, rawSessionId, SESSION_COOKIE_OPTIONS);
};

export const clearSessionCookie = (req: BunRequest): void => {
  req.cookies.delete(SESSION_COOKIE_NAME);
};

export const createGuestSession = async (): Promise<string> => {
  const rawSessionId = randomUUID();
  const sessionIdHash = computeHMAC(rawSessionId);
  const expiresAt = new Date(Date.now() + GUEST_EXPIRY_MS);

  await db`
    INSERT INTO cms_sessions (id_hash, session_type, expires_at)
    VALUES (${sessionIdHash}, 'guest', ${expiresAt.toISOString()})
  `;

  return rawSessionId;
};

export const createAuthenticatedSession = async (
  userId: string,
): Promise<string> => {
  const rawSessionId = randomUUID();
  const sessionIdHash = computeHMAC(rawSessionId);
  const expiresAt = new Date(Date.now() + AUTH_EXPIRY_MS);

  await db`
    INSERT INTO cms_sessions (id_hash, user_id, session_type, expires_at)
    VALUES (${sessionIdHash}, ${userId}, 'authenticated', ${expiresAt.toISOString()})
  `;

  return rawSessionId;
};

/**
 * Read one identity from the site's view, tolerating a missing view.
 *
 * `cms_identities` is created by the CMS only when it is missing and is owned by
 * the site, so it can legitimately be absent for a while — a site migration
 * drops it to retype a column, or the CMS booted before the site's first
 * deploy. A session must still be readable in that window, so a failed lookup
 * is a null identity rather than an error that discards the session.
 */
const loadIdentity = async (
  userId: string,
): Promise<{ id: string; email: string; role: string } | null> => {
  try {
    const rows = (await db.unsafe(
      `SELECT id, email, role FROM ${TABLES.identities} WHERE id = $1`,
      [userId],
    )) as { id: string; email: string; role: string }[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const getSessionContextFromDB = async (
  rawSessionId: string,
): Promise<SessionContext | null> => {
  try {
    const sessionIdHash = computeHMAC(rawSessionId);

    // The session row is read on its own, with no join onto `cms_identities`:
    // a missing view would otherwise make every session — guest sessions and
    // the CSRF secret they carry included — look absent, and every page would
    // mint a fresh guest row.
    const result = await db`
      SELECT id_hash, user_id, session_type
      FROM cms_sessions
      WHERE id_hash = ${sessionIdHash}
        AND expires_at > CURRENT_TIMESTAMP
    `;

    if (result.length === 0) return null;

    const data = result[0] as {
      id_hash: string;
      user_id: string | null;
      session_type: string;
    };

    // Re-read through the view on every request, so a site that removes an
    // account or drops its role from `cms_identities` ends the session at the
    // next request rather than when the cookie expires.
    const identity =
      data.session_type === "authenticated" && data.user_id
        ? await loadIdentity(data.user_id)
        : null;
    const user: User | null = identity
      ? {
          id: identity.id,
          email: identity.email,
          role: identity.role ?? "user",
        }
      : null;

    return {
      sessionId: rawSessionId,
      sessionHash: data.id_hash,
      sessionType: data.session_type as SessionType,
      user,
      isGuest: data.session_type === "guest",
      isAuthenticated: user !== null,
      requiresSetCookie: false,
    };
  } catch {
    return null;
  }
};

export const convertGuestToAuthenticated = async (
  sessionHash: string,
  userId: string,
): Promise<boolean> => {
  try {
    const expiresAt = new Date(Date.now() + AUTH_EXPIRY_MS);

    const result = await db`
      UPDATE cms_sessions
      SET user_id = ${userId},
          session_type = 'authenticated',
          expires_at = ${expiresAt.toISOString()}
      WHERE id_hash = ${sessionHash}
        AND session_type = 'guest'
        AND expires_at > CURRENT_TIMESTAMP
    `;

    return hasAffectedRows(result as DatabaseMutationResult);
  } catch {
    return false;
  }
};

export const deleteSession = async (rawSessionId: string): Promise<boolean> => {
  try {
    const sessionIdHash = computeHMAC(rawSessionId);

    const result = await db`
      DELETE FROM cms_sessions
      WHERE id_hash = ${sessionIdHash}
    `;

    return hasAffectedRows(result as DatabaseMutationResult);
  } catch {
    return false;
  }
};

/**
 * Delete every session belonging to a user, optionally sparing one.
 *
 * A failure here throws rather than returning a falsy result: a swallowed error
 * would claim a purge that never happened.
 */
export const deleteUserSessions = async (
  userId: string,
  exceptSessionHash?: string,
): Promise<number> => {
  const result = exceptSessionHash
    ? await db`
        DELETE FROM cms_sessions
        WHERE user_id = ${userId}
          AND id_hash != ${exceptSessionHash}
      `
    : await db`
        DELETE FROM cms_sessions
        WHERE user_id = ${userId}
      `;

  return (result as DatabaseMutationResult).count ?? 0;
};

export const renewSession = async (rawSessionId: string): Promise<boolean> => {
  try {
    const sessionIdHash = computeHMAC(rawSessionId);

    const result = await db`
      UPDATE cms_sessions
      SET last_activity_at = CURRENT_TIMESTAMP
      WHERE id_hash = ${sessionIdHash}
        AND expires_at > CURRENT_TIMESTAMP
    `;

    return hasAffectedRows(result as DatabaseMutationResult);
  } catch {
    return false;
  }
};
