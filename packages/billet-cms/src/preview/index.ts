/**
 * Preview: the CMS mints a token, the plugin renders drafts for it.
 *
 * Preview follows the same shape as the Edit content handoff — the two services
 * share a database and nothing else — but in the other direction. The CMS
 * creates a short-lived token for one subject (a page or a slot), links the
 * editor to the real page with `?cms_preview=…`, and the plugin checks the row
 * here before it renders. There is no API call and no shared secret: the token
 * is a row, and the plugin reads it.
 *
 * Two things make it safe to leave this on a public page's request path:
 *
 * 1. **The token is hashed at rest.** Only the SHA-256 is stored, so a database
 *    dump can't be replayed, exactly as the handoff token. Hashing is a plain
 *    SHA-256 rather than the HMAC the CMS's own tokens use, for the same reason:
 *    the two services have separate secrets and the window is short.
 * 2. **A bad token is the published view.** An unknown, spent or expired token
 *    resolves to `null`, which is what the reader already does for a draft — the
 *    site serves the published page and never errors. A database that is down is
 *    the same: the plugin logs and falls back, so the CMS being unavailable can
 *    never take a public page down.
 *
 * The token is single-*subject*, not single-use: the editor reloads the preview
 * as they work, so it is valid for its whole lifetime and covers exactly one
 * page or one slot. A page preview shows that page's latest draft and every
 * other slot on it as published; a slot preview shows that slot's draft inside
 * whatever app page renders it.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { PREVIEW_QUERY_PARAM, TABLES } from "../contract";

export { PREVIEW_QUERY_PARAM, PREVIEW_TOKEN_TTL_SECONDS } from "../contract";

/** The subject a preview token grants drafts for. */
export type PreviewSubjectType = "page" | "slot";

/** What a valid preview token covers: one page, or one slot. */
export interface PreviewAccess {
  subjectType: PreviewSubjectType;
  subjectId: string;
}

/** The SHA-256 hex of a raw preview token, which is what the database stores. */
export const hashPreviewToken = (rawToken: string): string =>
  createHash("sha256").update(rawToken).digest("hex");

/**
 * The subject a raw token covers, or `null` when it is unknown or expired.
 *
 * The expiry is compared in the query against a bound timestamp rather than
 * `CURRENT_TIMESTAMP`, so a test can present an expired token without waiting
 * and without the clock of the database and the process having to agree.
 */
export const readPreviewAccess = async (
  sql: SQL,
  rawToken: string,
  now: Date = new Date(),
): Promise<PreviewAccess | null> => {
  const rows = (await sql.unsafe(
    `SELECT subject_type, subject_id FROM ${TABLES.previewTokens}
     WHERE token_hash = $1 AND expires_at > $2`,
    [hashPreviewToken(rawToken), now],
  )) as { subject_type: PreviewSubjectType; subject_id: string }[];

  const row = rows[0];
  return row
    ? { subjectType: row.subject_type, subjectId: row.subject_id }
    : null;
};

export interface PreviewRequestOptions {
  now?: Date;
  /** Where a lookup that fails is reported. Defaults to a console warning. */
  onSkip?: (message: string) => void;
}

/**
 * The preview access a request carries, or `null`.
 *
 * Reads `?cms_preview=`, and answers `null` for a missing token, an unknown one,
 * an expired one, or a database the CMS tables aren't in yet. A caller therefore
 * never has to branch on an error: no access means the normal published read.
 */
export const getPreviewAccess = async (
  sql: SQL,
  req: Request,
  options: PreviewRequestOptions = {},
): Promise<PreviewAccess | null> => {
  let rawToken: string | null;
  try {
    rawToken = new URL(req.url).searchParams.get(PREVIEW_QUERY_PARAM);
  } catch {
    return null;
  }
  if (!rawToken) return null;

  try {
    return await readPreviewAccess(sql, rawToken, options.now ?? new Date());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.onSkip ?? defaultPreviewLogger)(
      `could not check the CMS preview token: ${message}`,
    );
    return null;
  }
};

const defaultPreviewLogger = (message: string): void => {
  // biome-ignore lint/suspicious/noConsole: the plugin's fallback logger, like `server/log.ts`
  console.warn(`[billet-cms] ${message}`);
};

/** The headers every preview response carries: no cache, no search engines. */
export const PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
} as const;

/** The id the banner carries, so a caller can find or style it. */
export const PREVIEW_BANNER_ID = "cms-preview-banner";

/**
 * The banner a previewed page shows, so an editor never mistakes a draft for
 * the live site. Inline styles: it appears on the *site's* page, whose CSS the
 * plugin does not own.
 */
export const renderPreviewBanner = (): string =>
  `<div id="${PREVIEW_BANNER_ID}" role="status" ` +
  'style="position:fixed;inset:0 0 auto 0;z-index:2147483647;' +
  "background:#b45309;color:#fff;font:600 14px/1.4 system-ui,sans-serif;" +
  'padding:8px 16px;text-align:center">' +
  "Preview — showing unpublished draft content. This is not the live site." +
  "</div>";

/**
 * Wrap a response in preview: the no-cache headers, and the banner for HTML.
 *
 * A non-HTML response (an image, JSON) keeps its body and only gains the
 * headers. `null` access returns the response untouched, so a caller can apply
 * this unconditionally and a request without a valid token is byte-identical to
 * one that never asked for a preview.
 */
export const applyPreview = async (
  response: Response,
  access: PreviewAccess | null,
): Promise<Response> => {
  if (!access) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PREVIEW_HEADERS)) {
    headers.set(name, value);
  }

  const contentType = headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const html = await response.text();
  const banner = renderPreviewBanner();
  // The body is about to change, so a length the producer set would be wrong.
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  const body = html.includes("</body>")
    ? html.replace("</body>", `${banner}</body>`)
    : `${banner}${html}`;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
