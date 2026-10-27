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
  /**
   * When the draft this preview shows was last saved, or `null` when the
   * subject has no revision yet.
   *
   * The banner prints it, which is what makes a stale preview explain itself:
   * an editor who typed, previewed without saving, and is now looking at
   * yesterday's words can see the time and know why. Without it the page is
   * simply wrong with no way to tell from the page.
   *
   * Optional rather than required: `readPreviewAccess` always sets it, but a
   * site forwarding or faking an access should not have to, and a banner
   * without a date is the behaviour this had before. Degrading quietly is
   * right for a label; it would not be for anything the page depends on.
   */
  draftSavedAt?: Date | null;
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
  // The newest revision for the subject comes back with the token, in one
  // read. The ordering matches `latestRevisionId` exactly (`created_at DESC,
  // id DESC`), so the time printed on the banner is the save the preview
  // actually renders rather than a different row that shares a timestamp.
  const rows = (await sql.unsafe(
    `SELECT t.subject_type, t.subject_id, r.created_at AS draft_saved_at
     FROM ${TABLES.previewTokens} t
     LEFT JOIN LATERAL (
       SELECT created_at FROM ${TABLES.revisions}
       WHERE target_type = t.subject_type AND target_id = t.subject_id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) r ON TRUE
     WHERE t.token_hash = $1 AND t.expires_at > $2`,
    [hashPreviewToken(rawToken), now],
  )) as {
    subject_type: PreviewSubjectType;
    subject_id: string;
    draft_saved_at: Date | null;
  }[];

  const row = rows[0];
  return row
    ? {
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        draftSavedAt: row.draft_saved_at ?? null,
      }
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

/**
 * The headers every preview response carries: no cache, no search engines, and
 * no referrer.
 *
 * The preview URL has the raw token in its query string, and the page's own
 * subresources — an analytics script, a third-party font — would otherwise be
 * sent that URL in `Referer` on every request. The token is live for its whole
 * half hour, so a third party that logged one could read the draft; `no-referrer`
 * keeps it out of the header. It also keeps the draft's URL away from whatever
 * the optional rich-text links point at.
 */
export const PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
} as const;

/** The id the banner carries, so a caller can find or style it. */
export const PREVIEW_BANNER_ID = "cms-preview-banner";

/**
 * The banner a previewed page shows, so an editor never mistakes a draft for
 * the live site. Inline styles: it appears on the *site's* page, whose CSS the
 * plugin does not own.
 *
 * `position: sticky` rather than `fixed`: the banner is injected as the first
 * child of `<body>` (see `injectPreviewBanner`), so sticky keeps it in the flow
 * — an editor scrolling the draft never has it cover the site's own header.
 * `role="region"` with a label, not `role="status"`: the banner is a persistent
 * landmark, not a transient announcement, so it should not be read out by a
 * screen reader on every page load.
 */
/**
 * When a draft was saved, as the banner prints it: "11 Jan 2026, 09:00 UTC".
 *
 * Composed from the parts rather than `toLocaleString({ dateStyle, timeStyle
 * })`, because the separator that joins the date and the time is ICU's to
 * choose and it changed — newer data gives en-GB "11 Jan 2026 at 09:00". This
 * string is read by an editor next to the CMS's own timestamps, so the two
 * must not drift apart depending on what the host happens to ship.
 *
 * UTC, like every other time the CMS shows, and said so on the label: an
 * editor comparing this against the save time in the history needs them to be
 * the same clock.
 */
export const formatDraftSavedAt = (date: Date): string => {
  const day = date.toLocaleDateString("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${day}, ${time} UTC`;
};

export const renderPreviewBanner = (
  access?: PreviewAccess | null,
  cmsUrl: string | undefined = typeof process === "undefined"
    ? undefined
    : process.env.CMS_URL,
): string => {
  const href = access ? editorUrl(access, cmsUrl) : null;
  const back = href
    ? ` <a href="${escapeAttribute(href)}" style="color:#fff;text-decoration:underline">Back to the editor</a>`
    : "";
  // Naming the save is what turns "this isn't what I typed" into "I previewed
  // before I saved". Escaped like any other value, even though it is built
  // from a Date and cannot currently carry markup — the banner is a string
  // concatenation on the site's own page, and nothing here should be the one
  // place that trusts its input.
  const saved = access?.draftSavedAt
    ? ` Draft saved ${escapeText(formatDraftSavedAt(access.draftSavedAt))}.`
    : "";
  return (
    `<div id="${PREVIEW_BANNER_ID}" role="region" aria-label="Preview" ` +
    'style="position:sticky;top:0;z-index:2147483647;' +
    "background:#b45309;color:#fff;font:600 14px/1.4 system-ui,sans-serif;" +
    'padding:8px 16px;text-align:center">' +
    "Preview — showing unpublished draft content. This is not the live site." +
    saved +
    back +
    "</div>"
  );
};

/**
 * The CMS editor for a preview's subject, or `null` when no usable `CMS_URL`
 * is set. Only an http(s) origin is accepted, and the ids are encoded into the
 * path, so the link can't be turned into a `javascript:` URL or a path escape.
 */
const editorUrl = (access: PreviewAccess, cmsUrl?: string): string | null => {
  const raw = (cmsUrl ?? "").trim();
  if (!raw) return null;
  try {
    const origin = new URL(raw);
    if (origin.protocol !== "http:" && origin.protocol !== "https:")
      return null;
    const kind = access.subjectType === "page" ? "pages" : "slots";
    const base = origin.origin + origin.pathname.replace(/\/+$/, "");
    return `${base}/cms/${kind}/${encodeURIComponent(access.subjectId)}`;
  } catch {
    return null;
  }
};

/** Escape a value going into the banner's text, not into an attribute. */
const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * The opening `<body>` tag, whatever case the site wrote it in.
 *
 * `<body` must be followed by `>` or whitespace, not just any character: the
 * loose `[^>]*` form would also match a custom element like `<body-guard>`,
 * putting the banner inside that element instead of the body's own flow.
 */
const BODY_OPEN = /<body(?:\s[^>]*)?>/i;

/**
 * Put the banner at the top of the rendered page.
 *
 * Right after the opening `<body>` tag, so it is the first thing in the flow. A
 * page with no `<body>` tag (an HTML fragment) gets the banner appended rather
 * than prepended: an insertion before the document would land ahead of
 * `<!doctype html>` and force quirks mode.
 */
const injectPreviewBanner = (html: string, banner: string): string => {
  const match = BODY_OPEN.exec(html);
  if (!match) return `${html}${banner}`;
  const end = match.index + match[0].length;
  return `${html.slice(0, end)}${banner}${html.slice(end)}`;
};

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

  // A body the producer already compressed can't be rewritten: reading it as
  // text would hand back the compressed bytes, not the markup, so injecting a
  // banner into it would corrupt the page. Apply the preview headers only and
  // leave the body — and its encoding — alone.
  if (headers.has("Content-Encoding")) {
    headers.delete("ETag");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const html = await response.text();
  const body = injectPreviewBanner(html, renderPreviewBanner(access));
  // The body was re-serialised, so the producer's framing headers no longer
  // describe it: the length, the ETag, and any encoding have all gone stale.
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Content-Encoding");

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
