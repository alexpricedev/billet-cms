/**
 * Preview tokens: the CMS mints one, the site's plugin spends it.
 *
 * Preview is a link the editor opens, not an authenticated API: the CMS writes a
 * short-lived token for a single subject (a page or a slot) into
 * `cms_preview_tokens`, and opens the site with `?cms_preview=…`. The plugin
 * reads the row and renders the draft. There is no shared secret, and the token
 * carries no content — it is only permission to see one subject's drafts.
 *
 * The raw token exists only in the link the CMS redirects the editor to; only
 * its SHA-256 is stored. `hashPreviewToken` comes from the plugin so the two
 * sides can never disagree about what is being hashed, exactly as the handoff
 * token does.
 *
 * Writing is a plain INSERT with no read-back, so a mint can never fail on
 * anything but the database being unreachable — and the controller turns that
 * into a notice rather than a 500.
 */
import { randomBytes } from "node:crypto";
import {
  hashPreviewToken,
  PREVIEW_QUERY_PARAM,
  PREVIEW_TOKEN_TTL_SECONDS,
  type PreviewSubjectType,
} from "@alexpricedev/billet-cms/preview";
import { sameOriginPath } from "@alexpricedev/billet-cms/server";
import { db } from "../database";

export type { PreviewSubjectType };

const PREVIEW_TOKEN_BYTES = 32;

export interface CreatePreviewTokenInput {
  subjectType: PreviewSubjectType;
  subjectId: string;
  /** The identity minting it, for the audit row. */
  createdBy: string | null;
  /** Injected clock, for tests. Defaults to now. */
  now?: Date;
  /** Override the lifetime, for tests. */
  ttlSeconds?: number;
}

export interface PreviewToken {
  /** The unhashed token, put in the preview URL. Never stored. */
  rawToken: string;
  expiresAt: Date;
}

/** Mint a preview token row and return the raw token for the link. */
export const createPreviewToken = async (
  input: CreatePreviewTokenInput,
): Promise<PreviewToken> => {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const rawToken = randomBytes(PREVIEW_TOKEN_BYTES).toString("base64url");

  await db`
    INSERT INTO cms_preview_tokens
      (subject_type, subject_id, token_hash, created_by, expires_at)
    VALUES (
      ${input.subjectType},
      ${input.subjectId},
      ${hashPreviewToken(rawToken)},
      ${input.createdBy},
      ${expiresAt}
    )
  `;

  return { rawToken, expiresAt };
};

export interface PreviewUrlInput {
  /**
   * The site's origin, `SITE_APP_URL`. `null`/blank means the CMS isn't pointed
   * at a site, and a preview link can't be built.
   */
  baseUrl: string | null | undefined;
  /** The site path to open: a page's URL, or a slot's declared preview path. */
  path: string;
  rawToken: string;
}

/**
 * The absolute URL the editor opens, or `null` when there is no site to open.
 *
 * The path is forced to a same-origin path first — a stored `//host` or a
 * backslash would otherwise navigate the editor off the site, exactly the check
 * the plugin's catch-all applies to a stored redirect. A path that doesn't pass
 * falls back to the site root rather than refusing the preview.
 */
export const buildPreviewUrl = (input: PreviewUrlInput): string | null => {
  const configured = input.baseUrl?.trim();
  if (!configured) return null;

  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    return null;
  }

  const path = sameOriginPath(input.path) ?? "/";

  try {
    const url = new URL(path, origin);
    url.searchParams.set(PREVIEW_QUERY_PARAM, input.rawToken);
    return url.href;
  } catch {
    return null;
  }
};
