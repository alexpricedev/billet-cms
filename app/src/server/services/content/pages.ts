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
import { UUID_PATTERN } from "../../utils/uuid";
import { db } from "../database";
import { getPageTypeByName, type PageTypeRecord } from "./definitions";
import { bumpContentVersion } from "./publishing";

export interface PageRecord {
  id: string;
  /** The page type's name, a loose reference to `cms_page_types.name`. */
  pageType: string;
  /** The canonical path the site serves, e.g. `/about`. */
  url: string;
  /**
   * A new address saved with the draft and waiting for Publish. `null` when the
   * live address is the only one; never equal to `url`.
   */
  draftUrl: string | null;
  title: string;
  seoDescription: string | null;
  socialImageId: string | null;
  publishedRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PageRow {
  id: string;
  page_type: string;
  url: string;
  draft_url: string | null;
  title: string;
  seo_description: string | null;
  social_image_id: string | null;
  published_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toPage = (row: PageRow): PageRecord => ({
  id: row.id,
  pageType: row.page_type,
  url: row.url,
  draftUrl: row.draft_url,
  title: row.title,
  seoDescription: row.seo_description,
  socialImageId: row.social_image_id,
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

export interface FieldSettingIssue {
  path: string;
  message: string;
}

/** The social-image issue for an id that names no upload. */
const SOCIAL_IMAGE_ISSUE: FieldSettingIssue = {
  path: "socialImageId",
  message: "Choose an image from the media library.",
};

/**
 * The issue a social-image id has, or `null` when it names a real upload.
 *
 * The value reaches a `uuid` column and then a foreign key, so it is checked
 * before either: a non-UUID would make Postgres fail with `invalid input
 * syntax` (a 500 for a typo), and a well-formed id that names no row would fail
 * the foreign key after the rest of the save had already been validated.
 */
const socialImageIssue = async (
  id: string,
): Promise<FieldSettingIssue | null> => {
  if (!UUID_PATTERN.test(id)) return SOCIAL_IMAGE_ISSUE;
  const rows = (await db`
    SELECT id FROM cms_media WHERE id = ${id}
  `) as { id: string }[];
  return rows.length > 0 ? null : SOCIAL_IMAGE_ISSUE;
};

export interface PageSettingsValues {
  url: string;
  title: string;
  seoDescription: string | null;
  socialImageId: string | null;
}

export type PageSettingsValidation =
  | ({ ok: true } & PageSettingsValues)
  | { ok: false; issues: FieldSettingIssue[] };

export interface PageSettingsInput {
  url: string;
  title: string;
  seoDescription?: string | null;
  socialImageId?: string | null;
}

/**
 * Validate the settings half of a page, independent of its content.
 *
 * Shared by create and update so the two can't drift: the editor sees the same
 * message whichever save it came from.
 */
export const validatePageSettings = async (
  input: PageSettingsInput,
): Promise<PageSettingsValidation> => {
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

  const socialImageId = input.socialImageId?.trim() ?? "";
  if (socialImageId !== "") {
    const issue = await socialImageIssue(socialImageId);
    if (issue) issues.push(issue);
  }

  if (issues.length > 0 || !url.ok) return { ok: false, issues };

  return {
    ok: true,
    url: url.url,
    title,
    seoDescription: seoDescription === "" ? null : seoDescription,
    socialImageId: socialImageId === "" ? null : socialImageId,
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
    SELECT id, page_type, url, draft_url, title, seo_description, social_image_id,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    ORDER BY url
  `) as PageRow[];
  return rows.map(toPage);
};

export type PageState =
  | { kind: "live" }
  | { kind: "draft"; since: Date }
  | { kind: "never" };

interface PageStateRow {
  id: string;
  published_revision_id: string | null;
  latest_id: string | null;
  latest_created_at: Date | null;
}

/**
 * Whether each page's newest edit is live, in one query for the whole list.
 *
 * The same shape as `listSlotStates`: the newest revision is the draft, and a
 * page with no published revision is "never", whatever drafts it has.
 */
export const listPageStates = async (): Promise<Map<string, PageState>> => {
  const rows = (await db`
    SELECT p.id, p.published_revision_id,
           latest.id AS latest_id, latest.created_at AS latest_created_at
    FROM cms_pages p
    LEFT JOIN LATERAL (
      SELECT id, created_at
      FROM cms_revisions
      WHERE target_type = 'page' AND target_id = p.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest ON true
  `) as PageStateRow[];

  const states = new Map<string, PageState>();
  for (const row of rows) {
    if (row.published_revision_id === null) {
      states.set(row.id, { kind: "never" });
    } else if (
      row.latest_id !== null &&
      row.latest_id !== row.published_revision_id &&
      row.latest_created_at
    ) {
      states.set(row.id, { kind: "draft", since: row.latest_created_at });
    } else {
      states.set(row.id, { kind: "live" });
    }
  }
  return states;
};

export const getPageById = async (id: string): Promise<PageRecord | null> => {
  const rows = (await db`
    SELECT id, page_type, url, draft_url, title, seo_description, social_image_id,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    WHERE id = ${id}
  `) as PageRow[];
  return rows.length > 0 ? toPage(rows[0]) : null;
};

export const getPageByUrl = async (url: string): Promise<PageRecord | null> => {
  const rows = (await db`
    SELECT id, page_type, url, draft_url, title, seo_description, social_image_id,
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
  const settings = await validatePageSettings(input);
  if (!settings.ok) return { ok: false, issues: settings.issues };

  const typeIssue = await pageTypeIssue(input.pageType);
  if (typeIssue) return { ok: false, issues: [typeIssue] };

  try {
    const page = await db.begin(async (tx) => {
      const id = randomUUID();
      // A published page can hold a path as a *pending* address change, which
      // no unique index covers, so the new page would otherwise take it and the
      // owner's Publish would fail later with a conflict. Refuse it here.
      const owner = await findPageHoldingUrl(tx, settings.url, id);
      if (owner) throw new PageUrlConflictError(settings.url, owner.title);
      await tx`DELETE FROM cms_redirects WHERE from_path = ${settings.url}`;
      const rows = (await tx`
        INSERT INTO cms_pages
          (id, page_type, url, title, seo_description, social_image_id)
        VALUES (
          ${id},
          ${input.pageType},
          ${settings.url},
          ${settings.title},
          ${settings.seoDescription},
          ${settings.socialImageId}
        )
        RETURNING id, page_type, url, draft_url, title, seo_description, social_image_id,
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
    const message = await duplicateUrlMessage(error, settings.url);
    if (message) return { ok: false, issues: [{ path: "url", message }] };
    throw error;
  }
};

/**
 * A URL another page already holds, found by the in-transaction pre-check.
 *
 * `draft_url` deliberately has no unique index (migration 019), so a pending
 * address change can only be refused in code; the same check also covers a live
 * address, which does have one. The owner's title travels in the error because
 * the message is built before the transaction rolls back — and `getPageByUrl`
 * would not find a page that only holds the URL as a draft.
 */
export class PageUrlConflictError extends Error {
  constructor(
    readonly url: string,
    readonly ownerTitle: string | null,
  ) {
    super(
      ownerTitle
        ? `${ownerTitle} already uses ${url}.`
        : "Another page already uses this URL.",
    );
    this.name = "PageUrlConflictError";
  }
}

/**
 * A URL collision on a page write, as an editor-facing message.
 *
 * The pre-check's error carries the owner's title. A unique-index violation on
 * the live URL is the fallback (and the cross-page race the pre-check can't
 * close): the lookup runs after the failed transaction, so it only ever reads a
 * committed row; if it finds nothing (the owner was renamed or deleted in
 * between) the message falls back to the old wording rather than naming nobody.
 */
export const duplicateUrlMessage = async (
  error: unknown,
  url: string,
): Promise<string | null> => {
  if (error instanceof PageUrlConflictError) return error.message;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { errno?: unknown }).errno;
  const constraint = (error as { constraint?: unknown }).constraint;
  if (code !== "23505" || constraint !== "cms_pages_url_idx") return null;
  const owner = await getPageByUrl(url);
  return owner
    ? `${owner.title} already uses ${url}.`
    : "Another page already uses this URL.";
};

/**
 * How a settings save treats a changed URL.
 *
 * `"draft"` is an editor's save: when the page has a published revision the new
 * address waits in `draft_url` until Publish, because the live address and its
 * redirect must not move under the site. A page with no published revision has
 * nothing live to protect, so its URL is written immediately even in this mode.
 * `"immediate"` is the old behaviour for a caller that means the address now.
 */
export type PageSettingsMode = "draft" | "immediate";

export interface UpdatePageSettingsInput extends PageSettingsInput {
  pageId: string;
  pageType: string;
}

export interface AppliedSettings {
  /** The page as it now stands (the stored row when nothing changed). */
  page: PageRecord;
  /**
   * Whether the settings row changed. A pending URL change alone writes the row
   * but does not bump `content_version`, so it is invisible to the site.
   */
  changed: boolean;
}

/**
 * The page other than `exceptPageId` holding `url`, live or as a pending draft.
 *
 * Runs under the saving page's row lock. It cannot stop two different pages
 * taking the same URL at once — no unique index spans `url` and `draft_url` —
 * which is why `applyDraftUrl` checks again inside the publish transaction.
 */
const findPageHoldingUrl = async (
  tx: SQL,
  url: string,
  exceptPageId: string,
): Promise<PageRecord | null> => {
  const rows = (await tx`
    SELECT id, page_type, url, draft_url, title, seo_description, social_image_id,
           published_revision_id, created_at, updated_at
    FROM cms_pages
    WHERE (url = ${url} OR draft_url = ${url})
      AND id <> ${exceptPageId}
    LIMIT 1
  `) as PageRow[];
  return rows.length > 0 ? toPage(rows[0]) : null;
};

/**
 * Write a page's settings inside a transaction.
 *
 * One transaction, one row lock, so two saves can't leave `cms_redirects`
 * describing a URL no page answers. The `UPDATE` and the
 * `cms_meta.content_version` bump are skipped when nothing changed (review
 * round 1): a title saved back unchanged shouldn't churn every site's cache.
 *
 * On a published page a URL change is stored in `draft_url`, not applied: `url`,
 * `cms_redirects` and `content_version` stay as they are until Publish calls
 * `applyDraftUrl` (ticket #66). A never-published page has no live address, so
 * its rename is applied straight away, exactly as before. Title, SEO and social
 * image still go live on save, because only the address is drafted.
 *
 * Shared by `updatePageSettings` and the atomic page save, so the two can't
 * disagree about what a rename means.
 */
export const applyPageSettings = async (
  tx: SQL,
  pageId: string,
  settings: PageSettingsValues,
  pageType: string,
  mode: PageSettingsMode,
): Promise<AppliedSettings> => {
  const locked = (await tx`
    SELECT id, page_type, url, draft_url, title, seo_description, social_image_id,
           published_revision_id, created_at, updated_at
    FROM cms_pages WHERE id = ${pageId} FOR UPDATE
  `) as PageRow[];
  if (locked.length === 0) throw new Error(`Page ${pageId} not found`);
  const previous = toPage(locked[0]);

  const urlChanged = previous.url !== settings.url;
  // Only a page with a published revision has a live address to keep.
  const draftUrlChange =
    mode === "draft" && previous.publishedRevisionId !== null;

  let nextUrl = previous.url;
  let nextDraftUrl = previous.draftUrl;

  if (draftUrlChange) {
    // Typing the live address back abandons a pending move; any other address
    // waits for Publish.
    nextDraftUrl = urlChanged ? settings.url : null;
    if (nextDraftUrl !== null) {
      const owner = await findPageHoldingUrl(tx, nextDraftUrl, pageId);
      if (owner) throw new PageUrlConflictError(nextDraftUrl, owner.title);
    }
  } else if (urlChanged) {
    const owner = await findPageHoldingUrl(tx, settings.url, pageId);
    if (owner) throw new PageUrlConflictError(settings.url, owner.title);
    nextUrl = settings.url;
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

  // The site's cache only knows what is live. A pending address change moves
  // nothing it can see, so it alone doesn't bump the version; title and SEO
  // still do, because they go live with the save.
  const liveChanged =
    (!draftUrlChange && urlChanged) ||
    previous.pageType !== pageType ||
    previous.title !== settings.title ||
    previous.seoDescription !== settings.seoDescription ||
    previous.socialImageId !== settings.socialImageId;
  const draftChanged = nextDraftUrl !== previous.draftUrl;

  if (!liveChanged && !draftChanged) {
    return { page: previous, changed: false };
  }

  const rows = (await tx`
    UPDATE cms_pages
    SET page_type = ${pageType},
        url = ${nextUrl},
        draft_url = ${nextDraftUrl},
        title = ${settings.title},
        seo_description = ${settings.seoDescription},
        social_image_id = ${settings.socialImageId},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${pageId}
    RETURNING id, page_type, url, draft_url, title, seo_description, social_image_id,
              published_revision_id, created_at, updated_at
  `) as PageRow[];
  if (liveChanged) await bumpContentVersion(tx);
  return { page: toPage(rows[0]), changed: true };
};

/** The move a pending URL change applies, for the editor's Published banner. */
export interface DraftUrlMove {
  from: string;
  to: string;
}

/**
 * Apply a page's pending address change: the old address redirects here, the
 * page moves to the drafted one, and `draft_url` is cleared.
 *
 * Runs inside the publish transaction, before the version bump, so the address,
 * the redirect and the publish land together. The address was checked when it
 * was saved, but another page may have taken it since (#66), so it is checked
 * again under the page's row lock; a taken address refuses the publish with the
 * same message a save gives, and the caller's transaction rolls back whole.
 */
export const applyDraftUrl = async (
  tx: SQL,
  pageId: string,
): Promise<DraftUrlMove | null> => {
  const rows = (await tx`
    SELECT url, draft_url FROM cms_pages WHERE id = ${pageId} FOR UPDATE
  `) as { url: string; draft_url: string | null }[];
  if (rows.length === 0) throw new Error(`Page ${pageId} not found`);

  const from = rows[0].url;
  const to = rows[0].draft_url;
  if (to === null) return null;
  if (to === from) {
    // A no-op draft should never be stored; clear one if it is.
    await tx`UPDATE cms_pages SET draft_url = NULL WHERE id = ${pageId}`;
    return null;
  }

  const owner = await findPageHoldingUrl(tx, to, pageId);
  if (owner) throw new PageUrlConflictError(to, owner.title);

  await tx`DELETE FROM cms_redirects WHERE from_path = ${to}`;
  await tx`
    INSERT INTO cms_redirects (id, from_path, to_page_id)
    VALUES (${randomUUID()}, ${from}, ${pageId})
    ON CONFLICT (from_path) DO UPDATE
      SET to_page_id = EXCLUDED.to_page_id
  `;
  await tx`
    UPDATE cms_pages
    SET url = ${to}, draft_url = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${pageId}
  `;
  return { from, to };
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
  const settings = await validatePageSettings(input);
  if (!settings.ok) return { ok: false, issues: settings.issues };

  const typeIssue = await pageTypeIssue(input.pageType);
  if (typeIssue) return { ok: false, issues: [typeIssue] };

  try {
    const page = await db.begin(async (tx) =>
      applyPageSettings(tx, input.pageId, settings, input.pageType, "draft"),
    );
    return { ok: true, page: page.page };
  } catch (error) {
    const message = await duplicateUrlMessage(error, settings.url);
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

/** The old paths that currently redirect to a page. */
export const listPageRedirects = async (pageId: string): Promise<string[]> => {
  const rows = (await db`
    SELECT from_path FROM cms_redirects
    WHERE to_page_id = ${pageId}
    ORDER BY from_path
  `) as { from_path: string }[];
  return rows.map((row) => row.from_path);
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
