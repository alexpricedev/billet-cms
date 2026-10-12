/**
 * The Edit content handoff.
 *
 * A site's template renders an "Edit content" link for a signed-in admin. The
 * link carries a single-use token the CMS spends to sign that admin in — the
 * site writes the token into the shared database, the CMS reads it there, and
 * neither service needs a secret the other knows or an API to call. The link is
 * the plugin helper in this module; the CMS's `/handoff` route is the other end.
 *
 * The token is short-lived (60 seconds) and single-use, so the window a leaked
 * link could be replayed is small and the CMS can refuse a second spend. Only
 * the SHA-256 of the token is stored, so a database dump can't be replayed as a
 * sign-in; the raw value exists only in the href the site rendered.
 *
 * Hashing is a plain SHA-256 rather than the HMAC the CMS's own tokens use: the
 * site and the CMS are separate services with separate secrets, and this token
 * is created and spent within a minute, so a pepper would only be a value the
 * two sides had to share. `hashHandoffToken` is exported so the CMS hashes the
 * presented token the same way instead of re-implementing it.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { TABLES } from "../contract";

/** How long a handoff token lives. Short: the link is opened right after it is rendered. */
export const HANDOFF_TOKEN_TTL_SECONDS = 60;

const HANDOFF_TOKEN_BYTES = 32;

/** The SHA-256 hex of a raw handoff token, which is what the database stores. */
export const hashHandoffToken = (rawToken: string): string =>
  createHash("sha256").update(rawToken).digest("hex");

export interface EditContentLinkOptions {
  /** The site user the link signs in. The CMS only hands in a `cms_identities` row. */
  userId: string;
  /**
   * The CMS origin. Defaults to `process.env.CMS_URL`; when neither is set the
   * helper returns `null` and the site hides the link (Q8).
   */
  cmsUrl?: string;
  /** The CMS path the link points at. Defaults to `/handoff`. */
  path?: string;
  /** Injected clock, for tests. */
  now?: Date;
  /** Override the lifetime, for tests. */
  ttlSeconds?: number;
}

/**
 * Mint a single-use handoff token and return the URL that spends it, or `null`
 * when the site has no CMS configured or the user isn't a CMS identity.
 *
 * The helper is deliberately forgiving: a site renders this link inside its own
 * pages, which must keep working when the CMS is down, mid-deploy or not yet
 * set up. A missing `CMS_URL`, a missing `cms_identities` view or a database
 * error all hide the link rather than breaking the page it is rendered on.
 */
export const createEditContentLink = async (
  sql: SQL,
  options: EditContentLinkOptions,
): Promise<string | null> => {
  const cmsUrl = (options.cmsUrl ?? process.env.CMS_URL ?? "").trim();
  if (!cmsUrl) return null;

  try {
    const identity = (await sql.unsafe(
      `SELECT 1 FROM ${TABLES.identities} WHERE id = $1`,
      [options.userId],
    )) as unknown[];
    if (identity.length === 0) return null;

    const now = options.now ?? new Date();
    const ttlMs = (options.ttlSeconds ?? HANDOFF_TOKEN_TTL_SECONDS) * 1000;
    const rawToken = randomBytes(HANDOFF_TOKEN_BYTES).toString("base64url");

    await sql.unsafe(
      `INSERT INTO ${TABLES.handoffTokens} (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        options.userId,
        hashHandoffToken(rawToken),
        new Date(now.getTime() + ttlMs),
      ],
    );

    const base = cmsUrl.replace(/\/+$/, "");
    const path = options.path ?? "/handoff";
    return `${base}${path}?token=${encodeURIComponent(rawToken)}`;
  } catch {
    // No CMS tables yet, or the CMS is unreachable. The site keeps working.
    return null;
  }
};
