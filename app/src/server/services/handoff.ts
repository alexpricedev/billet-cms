import { hashHandoffToken } from "@alexpricedev/billet-cms/handoff";
import type { User } from "./auth";
import { findUserById, regenerateSession } from "./auth";
import { db } from "./database";

/**
 * The CMS half of the Edit content handoff.
 *
 * The site's plugin mints the token (see `@alexpricedev/billet-cms/handoff`)
 * and the CMS spends it here. The token is single-use and short-lived: the
 * conditional UPDATE that claims it is the same race-safe shape the rest of the
 * CMS's single-use tokens use, so two clicks on one link produce exactly one
 * session.
 */
export type HandoffResult =
  | { success: true; user: User; sessionId: string }
  | { success: false; error: string; reason: "invalid" | "no-account" };

/**
 * Claim a handoff token, returning the identity id it was minted for or null
 * when it is unknown, spent or expired.
 */
export const consumeHandoffToken = async (
  rawToken: string,
): Promise<string | null> => {
  const results = await db`
    UPDATE cms_handoff_tokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE token_hash = ${hashHandoffToken(rawToken)}
      AND used_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING user_id
  `;

  return results.length > 0 ? (results[0].user_id as string) : null;
};

export type HandoffState = "valid" | "spent" | "expired" | "unknown";

/**
 * Read a handoff token's state without spending it, so the confirm page can
 * say a link is dead before the person taps Continue. Read-only: a GET that
 * wrote would let a link scanner burn the token.
 */
export const peekHandoffToken = async (
  rawToken: string,
): Promise<HandoffState> => {
  const rows = await db`
    SELECT used_at IS NOT NULL AS spent, expires_at <= CURRENT_TIMESTAMP AS expired
    FROM cms_handoff_tokens
    WHERE token_hash = ${hashHandoffToken(rawToken)}
  `;

  if (rows.length === 0) return "unknown";
  if (rows[0].spent) return "spent";
  return rows[0].expired ? "expired" : "valid";
};

/**
 * Spend a handoff token and start the session it was minted for.
 *
 * The identity is re-read from `cms_identities` before the session is issued:
 * a link minted by a site that has since removed the person's access signs
 * nobody in.
 */
export const redeemHandoffToken = async (
  rawToken: string,
  previousSessionId?: string | null,
): Promise<HandoffResult> => {
  const userId = await consumeHandoffToken(rawToken);

  if (!userId) {
    return {
      success: false,
      error: "Invalid or expired link",
      reason: "invalid",
    };
  }

  const user = await findUserById(userId);

  if (!user) {
    return {
      success: false,
      error: "This account can no longer sign in",
      reason: "no-account",
    };
  }

  const sessionId = await regenerateSession(userId, previousSessionId);

  return { success: true, user, sessionId };
};
