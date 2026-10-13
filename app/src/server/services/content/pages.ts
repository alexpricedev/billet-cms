/**
 * Pages: the CMS's own content, created against a page type.
 *
 * A page is not something a deploy publishes. The site declares page *types*
 * (which blocks a page may contain, which it must, and their limits) and an
 * editor builds pages here. A page carries its settings — URL, title, SEO
 * description, social image — and points at the published revision the site
 * renders, the same way a slot does.
 *
 * Two rules this module owns:
 *
 * 1. **A URL is a canonical path.** The site's catch-all matches `url.pathname`,
 *    so a page's URL is stored as a slash-free path with a leading slash
 *    (`/about`), which is exactly the form Billet's trailing-slash
 *    canonicalisation leaves in place. `normalisePageUrl` is the one place that
 *    shape is decided.
 * 2. **Changing a URL writes a 301.** The old path goes into `cms_redirects`
 *    pointing at the page *id*, so the redirect keeps working after a second
 *    rename and a link stored by id (`link()` fields) never has to change. A
 *    page created at a path a redirect currently owns takes the path back, and
 *    the redirect is removed so the new page is reachable.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { db } from "../database";
import { getPageTypeByName, type PageTypeRecord } from "./definitions";
import { bumpContentVersion } from "./publishing";

export interface PageRecord {
  id: string;
  /** The page type's name, a loose reference to `cms_page_types.name`. */
  pageType: string;
  /** The canonical path, e.g. `/about`. */
  url: string;
  title: string;
  seoDescription: string | null;
  socialImage: string | null;
  publishedRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PageRow {
  id: string;
  page_type: string;
  url: string;
  title: string;
  seo_description: string | null;
  social_image: string | null;
  published_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toPage = (row: PageRow): PageRecord => ({
  id: row.id,
  pageType: row.page_type,
  url: row.url,
  title: row.title,
  seoDescription: row.seo_description,
  socialImage: row.social_image,
  publishedRevisionId: row.published_revision_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The longest a page URL may be. Generous; a real path is far shorter. */
export const MAX_PAGE_URL_LENGTH = 2048;

/** The longest a page title may be, matching a sane `<title>` before truncation. */
export const MAX_PAGE_TITLE_LENGTH = 200;

/** The longest an SEO description may be, in the runbook's ~150-char range. */
export const MAX_SEO_DESCRIPTION_LENGTH = 320;

export type UrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/** True for a C0/C1 control character, which a path must never carry. */
const hasControlCharacters = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** The origin `new URL` resolves a page path against. Never stored. */
const URL_BASE = "http://cms.local";

/**
 * Turn what an editor typed into the canonical path a page is stored at.
 *
 * Accepts a bare segment (`about`) or a path (`/about`), collapses repeated
 * slashes and drops a trailing slash, so every spelling of one URL normalises
 * to the same row and the unique index catches a genuine duplicate rather than
 * a formatting difference. The result is then run through `new URL` and kept as
 * `pathname`, so `.`/`..` segments are resolved and non-ASCII characters are
 * percent-encoded the same way a browser's `url.pathname` is — the exact string
 * the site's catch-all compares against (review round 1).
 *
 * A backslash is refused rather than normalised: browsers treat `\` as `/`, so
 * `/\evil.example` is `//evil.example` in disguise and would become a
 * protocol-relative (off-site) redirect target. A query string or fragment is
 * refused rather than silently dropped: a page's URL is a path, and quietly
 * discarding half of what someone typed is how a redirect ends up pointing
 * somewhere unexpected.
 */
export const normalisePageUrl = (raw: string): UrlResult => {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "Enter a URL." };
  if (trimmed.length > MAX_PAGE_URL_LENGTH) {
    return { ok: false, message: "That URL is too long." };
  }
  if (/[\s?#]/.test(trimmed)) {
    return {
      ok: false,
      message: "A URL can't contain spaces, a query string or a fragment.",
    };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, message: "A URL can't contain a backslash." };
  }
  if (hasControlCharacters(trimmed)) {
    return { ok: false, message: "That URL contains characters we can't use." };
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");

  let pathname: string;
  try {
    pathname = new URL(collapsed, URL_BASE).pathname;
  } catch {
    return { ok: false, message: "That URL isn't valid." };
  }

  const url = pathname.length > 1 ? pathname.replace(/\/+$/, "") : "/";
  return { ok: true, url };
};

/**
 * True for a social image the site can safely put in a tag.
 *
 * A site-relative path (`/og/about.png`) or an absolute http(s) URL. A
 * protocol-relative `//host` and a backslash are refused for the same reason the
 * link field refuses them: they navigate off-site, whatever they look like.
 */
const isUsableImageUrl = (value: string): boolean => {
  if (value.includes("\\")) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export interface FieldSettingIssue {
  path: string;
  message: string;
}

export interface PageSettingsValues {
  url: string;
  title: string;
  seoDescription: string | null;
  socialImage: string | null;
}

export type PageSettingsValidation =
  | ({ ok: true } & PageSettingsValues)
  | { ok: false; issues: FieldSettingIssue[] };

export interface PageSettingsInput {
  url: string;
  title: string;
  seoDescription?: string | null;
  socialImage?: string | null;
}

/**
 * Validate the settings half of a page, independent of its content.
 *
 * Shared by create and update so the two can't drift: the editor sees the same
 * message whichever save it came from.
 */
export const validatePageSettings = (
  input: PageSettingsInput,
): PageSettingsValidation => {
  const issues: FieldSettingIssue[] = [];

  const title = input.title.trim();
  if (title === "") {
    issues.push({ path: "title", message: "Enter a title." });
  } else if (title.length > MAX_PAGE_TITLE_LENGTH) {
    issues.push({
      path: "title",
      message: `Use ${MAX_PAGE_TITLE_LENGTH} characters or fewer.`,
    });
  }

  const url = normalisePageUrl(input.url);
  if (!url.ok) issues.push({ path: "url", message: url.message });

  const seoDescription = input.seoDescription?.trim() ?? "";
  if (seoDescription.length > MAX_SEO_DESCRIPTION_LENGTH) {
    issues.push({
      path: "seoDescription",
      message: `Use ${MAX_SEO_DESCRIPTION_LENGTH} characters or fewer.`,
    });
  }

  const socialImage = input.socialImage?.trim() ?? "";
  if (socialImage !== "" && !isUsableImageUrl(socialImage)) {
    issues.push({
      path: "socialImage",
      message:
        "Enter an http(s) image URL, or a path on this site starting with /.",
    });
  }

  if (issues.length > 0 || !url.ok) return { ok: false, issues };

  return {
    ok: true,
    url: url.url,
    title,
    seoDescription: seoDescription === "" ? null : seoDescription,
    socialImage: socialImage === "" ? null : socialImage,
  };
};

/**
 * The page type an editor may write a page against, or `null`.
 *
 * A page type a deploy removed is not writable: its definition is gone, so the
 * CMS can't validate the page's blocks or build its editor. It is kept (Q4) so
 * an existing page still reads back, but it can't be chosen for a new page or
 * switched to on an existing one.
 */
export const resolveWritablePageType = async (
  name: string,
): Promise<PageTypeRecord | null> => {
  const pageType = await getPageTypeByName(name);
  return pageType && !pageType.removedAt ? pageType : null;
};

/** The field issue a page type that isn't writable reports, or `null`. */
const pageTypeIssue = async (
  name: string,
): Promise<FieldSettingIssue | null> =>
  (await resolveWritablePageType(name)) === null
    ? { path: "pageType", message: "Choose a published page type." }
    : null;

export type PageResult =
  | { ok: true; page: PageRecord }
  | { ok: false; issues: FieldSettingIssue[] };

export const listPages = async (): Promise<PageRecord[]> => {
  const rows = (await db`
    SELECT id, page_type, url, title, seo_description, social_image,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    ORDER BY url
  `) as PageRow[];
  return rows.map(toPage);
};

export const getPageById = async (id: string): Promise<PageRecord | null> => {
  const rows = (await db`
    SELECT id, page_type, url, title, seo_description, social_image,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    WHERE id = ${id}
  `) as PageRow[];
  return rows.length > 0 ? toPage(rows[0]) : null;
};

export const getPageByUrl = async (url: string): Promise<PageRecord | null> => {
  const rows = (await db`
    SELECT id, page_type, url, title, seo_description, social_image,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    WHERE url = ${url}
  `) as PageRow[];
  return rows.length > 0 ? toPage(rows[0]) : null;
};

export interface CreatePageInput extends PageSettingsInput {
  pageType: string;
}

/**
 * Create a page, or report the settings that stopped it.
 *
 * A redirect already sitting on the new URL is removed: the page now owns that
 * path, and leaving the redirect in place would send the site's catch-all
 * somewhere else before it ever looked for the page. Both run in one
 * transaction so a failure can't leave the path without its page.
 */
export const createPage = async (
  input: CreatePageInput,
): Promise<PageResult> => {
  const settings = validatePageSettings(input);
  if (!settings.ok) return { ok: false, issues: settings.issues };

  const typeIssue = await pageTypeIssue(input.pageType);
  if (typeIssue) return { ok: false, issues: [typeIssue] };

  try {
    const page = await db.begin(async (tx) => {
      await tx`DELETE FROM cms_redirects WHERE from_path = ${settings.url}`;
      const rows = (await tx`
        INSERT INTO cms_pages
          (id, page_type, url, title, seo_description, social_image)
        VALUES (
          ${randomUUID()},
          ${input.pageType},
          ${settings.url},
          ${settings.title},
          ${settings.seoDescription},
          ${settings.socialImage}
        )
        RETURNING id, page_type, url, title, seo_description, social_image,
                  published_revision_id, created_at, updated_at
      `) as PageRow[];
      // The site caches pages, redirects and links against `content_version`.
      // A new page changes what its paths resolve to, so the counter moves and
      // the site's cache drops within a second — the same signal a publish uses.
      await bumpContentVersion(tx);
      return toPage(rows[0]);
    });
    return { ok: true, page };
  } catch (error) {
    const message = duplicateUrlMessage(error);
    if (message) return { ok: false, issues: [{ path: "url", message }] };
    throw error;
  }
};

/** A unique violation on the URL, as an editor-facing message. */
const duplicateUrlMessage = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { errno?: unknown }).errno;
  const constraint = (error as { constraint?: unknown }).constraint;
  if (code === "23505" && constraint === "cms_pages_url_idx") {
    return "Another page already uses this URL.";
  }
  return null;
};

export interface UpdatePageSettingsInput extends PageSettingsInput {
  pageId: string;
  pageType: string;
}

export interface AppliedSettings {
  /** The page as it now stands (the stored row when nothing changed). */
  page: PageRecord;
  /** Whether the settings write (and the version bump) happened. */
  changed: boolean;
}

/**
 * Write a page's settings inside a transaction, writing the 301 a URL change
 * leaves behind.
 *
 * One transaction, one row lock, so two renames can't leave `cms_redirects`
 * describing a URL no page answers. The `UPDATE` and the `cms_meta.content_version`
 * bump are skipped when nothing changed (review round 1): a title saved back
 * unchanged shouldn't churn every site's cache. A URL change always writes the
 * redirect and bumps the version, because the site's routing changed.
 *
 * Shared by `updatePageSettings` and the atomic page save, so the two can't
 * disagree about what a rename means.
 */
export const applyPageSettings = async (
  tx: SQL,
  pageId: string,
  settings: PageSettingsValues,
  pageType: string,
): Promise<AppliedSettings> => {
  const locked = (await tx`
    SELECT id, page_type, url, title, seo_description, social_image,
           published_revision_id, created_at, updated_at
    FROM cms_pages WHERE id = ${pageId} FOR UPDATE
  `) as PageRow[];
  if (locked.length === 0) throw new Error(`Page ${pageId} not found`);
  const previous = toPage(locked[0]);

  const urlChanged = previous.url !== settings.url;
  if (urlChanged) {
    // A page now owns the new path, so any redirect from it goes: the catch-all
    // checks redirects first, and a stale one would shadow the page.
    await tx`DELETE FROM cms_redirects WHERE from_path = ${settings.url}`;
    await tx`
      INSERT INTO cms_redirects (id, from_path, to_page_id)
      VALUES (${randomUUID()}, ${previous.url}, ${pageId})
      ON CONFLICT (from_path) DO UPDATE
        SET to_page_id = EXCLUDED.to_page_id
    `;
  }

  const changed =
    urlChanged ||
    previous.pageType !== pageType ||
    previous.title !== settings.title ||
    previous.seoDescription !== settings.seoDescription ||
    previous.socialImage !== settings.socialImage;

  if (!changed) return { page: previous, changed: false };

  const rows = (await tx`
    UPDATE cms_pages
    SET page_type = ${pageType},
        url = ${settings.url},
        title = ${settings.title},
        seo_description = ${settings.seoDescription},
        social_image = ${settings.socialImage},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${pageId}
    RETURNING id, page_type, url, title, seo_description, social_image,
              published_revision_id, created_at, updated_at
  `) as PageRow[];
  // Settings are cached by the site too (a title, a description, a redirect from
  // the old URL), so a settings change moves the version and the site's cache
  // drops within a second.
  await bumpContentVersion(tx);
  return { page: toPage(rows[0]), changed: true };
};

/**
 * Update a page's settings outside a caller's transaction.
 *
 * Validates first, then hands the write to `applyPageSettings`. The redirect
 * points at the page id, not the new URL, so it survives a second rename.
 */
export const updatePageSettings = async (
  input: UpdatePageSettingsInput,
): Promise<PageResult> => {
  const settings = validatePageSettings(input);
  if (!settings.ok) return { ok: false, issues: settings.issues };

  const typeIssue = await pageTypeIssue(input.pageType);
  if (typeIssue) return { ok: false, issues: [typeIssue] };

  try {
    const page = await db.begin(async (tx) =>
      applyPageSettings(tx, input.pageId, settings, input.pageType),
    );
    return { ok: true, page: page.page };
  } catch (error) {
    const message = duplicateUrlMessage(error);
    if (message) return { ok: false, issues: [{ path: "url", message }] };
    throw error;
  }
};

/**
 * Delete a page. Its redirects cascade; its revisions stay as history.
 *
 * The content version moves too: a deleted page's URL now 404s (or resolves to
 * whatever a remaining redirect says), and the site's cache has to drop for that
 * to happen within a second rather than at its next restart.
 */
export const deletePage = async (id: string): Promise<boolean> => {
  return await db.begin(async (tx) => {
    const rows = (await tx`
      DELETE FROM cms_pages WHERE id = ${id} RETURNING id
    `) as { id: string }[];
    if (rows.length === 0) return false;
    await bumpContentVersion(tx);
    return true;
  });
};

export interface RedirectRecord {
  id: string;
  fromPath: string;
  toPageId: string;
}

export const listRedirects = async (): Promise<RedirectRecord[]> => {
  const rows = (await db`
    SELECT id, from_path, to_page_id FROM cms_redirects ORDER BY from_path
  `) as { id: string; from_path: string; to_page_id: string }[];
  return rows.map((row) => ({
    id: row.id,
    fromPath: row.from_path,
    toPageId: row.to_page_id,
  }));
};

/** A page as the link picker needs it: enough to tell two options apart. */
export interface PageOption {
  id: string;
  title: string;
  url: string;
}

export const listPageOptions = async (): Promise<PageOption[]> => {
  const rows = (await db`
    SELECT id, title, url FROM cms_pages ORDER BY title, url
  `) as PageOption[];
  return rows;
};

/** The current URL of a page link target, or `null` when it no longer exists. */
export const resolvePageUrl = async (
  pageId: string,
  sql: SQL = db,
): Promise<string | null> => {
  const rows = (await sql`
    SELECT url FROM cms_pages WHERE id = ${pageId}
  `) as { url: string }[];
  return rows.length > 0 ? rows[0].url : null;
};

/** What deleting a page would leave behind, for the delete confirm step. */
export interface PageUsage {
  /** Redirects that currently point at this page. */
  redirectCount: number;
  /** Other pages whose current or published content links to this page. */
  linkingPages: PageOption[];
}

/** True when a stored content value contains a page-mode link to `pageId`. */
export const referencesPage = (value: unknown, pageId: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesPage(entry, pageId));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "page" && record.pageId === pageId) return true;
  return Object.values(record).some((entry) => referencesPage(entry, pageId));
};

interface UsageRow {
  id: string;
  title: string;
  url: string;
  latest_content: Record<string, unknown> | null;
  published_content: Record<string, unknown> | null;
}

/**
 * What a page's deletion affects: its redirects and the pages linking to it.
 *
 * A link is stored as a page id, so finding the linkers means walking the
 * content a page currently shows — its newest revision and, when different,
 * the revision the site is serving. Both are checked, because a link removed in
 * a draft is still live until it is published. The delete confirm step shows
 * this and nothing here blocks the delete.
 */
export const getPageUsage = async (pageId: string): Promise<PageUsage> => {
  const redirects = (await db`
    SELECT COUNT(*)::int AS count
    FROM cms_redirects
    WHERE to_page_id = ${pageId}
  `) as { count: number }[];

  const rows = (await db`
    SELECT p.id, p.title, p.url,
           latest.content AS latest_content,
           published.content AS published_content
    FROM cms_pages p
    LEFT JOIN LATERAL (
      SELECT content FROM cms_revisions r
      WHERE r.target_type = 'page' AND r.target_id = p.id
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN cms_revisions published ON published.id = p.published_revision_id
    WHERE p.id <> ${pageId}
    ORDER BY p.url
  `) as UsageRow[];

  const linkingPages = rows
    .filter(
      (row) =>
        (row.latest_content !== null &&
          referencesPage(row.latest_content, pageId)) ||
        (row.published_content !== null &&
          referencesPage(row.published_content, pageId)),
    )
    .map((row) => ({ id: row.id, title: row.title, url: row.url }));

  return { redirectCount: redirects[0]?.count ?? 0, linkingPages };
};
