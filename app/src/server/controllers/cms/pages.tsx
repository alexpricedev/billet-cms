import type { BunRequest } from "bun";
import type { FieldError } from "../../components/cms/field-control";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf, isRecoverableCsrfFailure } from "../../middleware/csrf";
import {
  asPageContent,
  type BlockTypeRecord,
  createPage,
  deletePage,
  type FieldIssue,
  findUnavailableBlocks,
  getLatestRevision,
  getPageById,
  getPageTypeByName,
  getPageUsage,
  getRevisionById,
  listBlockTypes,
  listPageOptions,
  listPages,
  listPageTypes,
  listRedirects,
  type PageBlock,
  type PageRecord,
  type PageSettingsInput,
  type PageTypeRecord,
  type RevisionConflict,
  resolveWritablePageType,
  savePage,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { listMediaOptions } from "../../services/media";
import type { SessionContext } from "../../services/sessions";
import { PageDeleteConfirm } from "../../templates/cms/page-delete";
import {
  NewPageForm,
  PageForm,
  PageUnavailable,
} from "../../templates/cms/page-form";
import { PagesList } from "../../templates/cms/pages";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { nonEmpty, parseContent, UUID_PATTERN } from "./params";

/**
 * A one-line outcome shown above a page form after a save, publish or restore.
 * Redirects carry the state in the query so a refresh repeats the notice rather
 * than the action.
 */
export interface Notice {
  kind: "success" | "warning";
  message: string;
}

export const pageNotice = (params: URLSearchParams): Notice | null => {
  if (params.get("saved") === "1") {
    return { kind: "success", message: "Draft saved." };
  }
  if (params.get("published") === "1") {
    return {
      kind: "success",
      message: "Published. The site picks the change up within seconds.",
    };
  }
  if (params.get("restored") === "1") {
    return {
      kind: "success",
      message: "Restored as a new draft. Publish to make it live.",
    };
  }
  if (params.get("deleted") === "1") {
    return { kind: "success", message: "Page deleted." };
  }
  if (params.get("publish") === "empty") {
    return { kind: "warning", message: "There is no draft to publish yet." };
  }
  if (params.get("publish") === "stale") {
    return {
      kind: "warning",
      message:
        "Someone saved a newer draft while this page was open, so nothing was published. Reload the page to see and publish the newest version.",
    };
  }
  if (params.get("preview") === "failed") {
    return {
      kind: "warning",
      message:
        "Preview couldn't start: the CMS couldn't create a preview link. Try again.",
    };
  }
  return null;
};

const SETTINGS_FIELDS = new Set([
  "pageType",
  "url",
  "title",
  "seoDescription",
  "socialImage",
]);

/** The blocks' own name for a block, with the block-type label when one exists. */
const blockTypeMap = (
  blockTypes: BlockTypeRecord[],
): Map<string, BlockTypeRecord> =>
  new Map(blockTypes.map((blockType) => [blockType.name, blockType]));

/** Split content issues into a per-block map and a flat list for the summary. */
const blockErrors = (
  issues: FieldIssue[],
): { byBlock: Map<number, Map<string, FieldError[]>>; list: FieldIssue[] } => {
  const byBlock = new Map<number, Map<string, FieldError[]>>();
  const list: FieldIssue[] = [];

  for (const issue of issues) {
    const match = /^blocks\.(\d+)\.(.+)$/.exec(issue.path);
    if (!match) {
      // A limit issue's path is just `blocks`; it belongs in the summary.
      list.push(issue);
      continue;
    }
    const index = Number(match[1]);
    const field = match[2];
    // A control is looked up by its own field name, so a nested issue
    // (`link.pageId`) is keyed under the top-level field (`link`) that owns the
    // control the message belongs beside (review round 1).
    const group = field.split(".")[0];
    const fields = byBlock.get(index) ?? new Map<string, FieldError[]>();
    const errors = fields.get(group) ?? [];
    errors.push({ path: field, message: issue.message });
    fields.set(group, errors);
    byBlock.set(index, fields);
    list.push(issue);
  }

  return { byBlock, list };
};

interface FormExtras {
  errors?: FieldIssue[];
  conflict?: RevisionConflict | null;
  notice?: Notice | null;
  /**
   * The settings the editor typed, when a save failed. Without it the form
   * re-renders the stored settings and silently discards their input (review
   * round 1).
   */
  settings?: PageSettingsInput & { pageType: string };
  /**
   * Flagged blocks the editor removed, so a re-render after a failed save keeps
   * the removal instead of resurrecting the block on the next save (review
   * round 2).
   */
  removed?: number[];
}

/**
 * Render a page's editor.
 *
 * Shared by the GET and by every POST outcome that re-renders rather than
 * redirects, so a validation failure, a conflict and an expired page all show
 * the same controls around the same content and the same inline errors.
 */
export const renderPageForm = async (
  ctx: SessionContext,
  page: PageRecord,
  pageType: PageTypeRecord | null,
  content: PageBlock[],
  baseRevisionId: string | null,
  extras: FormExtras = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const user = ctx.user as NonNullable<SessionContext["user"]>;

  const [blockTypes, pageTypes, pages, media, latest] = await Promise.all([
    listBlockTypes(),
    listPageTypes(),
    listPageOptions(),
    listMediaOptions(),
    getLatestRevision("page", page.id),
  ]);

  const navCsrfToken = await createCsrfToken(sessionId, "POST", "/auth/logout");

  if (!pageType) {
    return render(
      <PageUnavailable user={user} page={page} navCsrfToken={navCsrfToken} />,
    );
  }

  const [formCsrfToken, publishCsrfToken, previewCsrfToken] = await Promise.all(
    [
      createCsrfToken(sessionId, "POST", `/cms/pages/${page.id}`),
      createCsrfToken(sessionId, "POST", `/cms/pages/${page.id}/publish`),
      createCsrfToken(sessionId, "POST", `/cms/pages/${page.id}/preview`),
    ],
  );

  const issues = extras.errors ?? [];
  const settingsIssues = issues.filter((issue) =>
    SETTINGS_FIELDS.has(issue.path),
  );
  const contentIssues = issues.filter(
    (issue) => !SETTINGS_FIELDS.has(issue.path),
  );
  const { byBlock, list } = blockErrors(contentIssues);

  const settingsErrors = new Map<string, FieldError[]>();
  for (const issue of settingsIssues) {
    const list = settingsErrors.get(issue.path) ?? [];
    list.push({ path: issue.path, message: issue.message });
    settingsErrors.set(issue.path, list);
  }

  return render(
    <PageForm
      user={user}
      formCsrfToken={formCsrfToken}
      publishCsrfToken={publishCsrfToken}
      previewCsrfToken={previewCsrfToken}
      navCsrfToken={navCsrfToken}
      page={page}
      pageTypes={pageTypes}
      pageType={pageType}
      blockTypes={blockTypes}
      content={content}
      unavailable={findUnavailableBlocks(
        pageType,
        content,
        blockTypeMap(blockTypes),
      )}
      baseRevisionId={baseRevisionId}
      removed={extras.removed ?? []}
      latestRevisionId={latest?.id ?? null}
      publishedRevisionId={page.publishedRevisionId}
      pages={pages}
      media={media}
      settingsErrors={settingsErrors}
      blockErrors={byBlock}
      contentIssues={list}
      conflict={extras.conflict ?? null}
      notice={extras.notice ?? null}
      values={extras.settings}
    />,
  );
};

/** The content to show when a posted one can't be used: the revision they loaded. */
const baseContent = async (
  baseRevisionId: string | null,
  page: PageRecord,
): Promise<PageBlock[]> => {
  if (!baseRevisionId) return [];
  const revision = await getRevisionById(baseRevisionId);
  if (!revision) return [];
  if (revision.targetType !== "page" || revision.targetId !== page.id)
    return [];
  return asPageContent(revision.content).blocks;
};

/** The settings fields, as the form sends them. */
const settingsFrom = (formData: FormData) => ({
  pageType: nonEmpty(formData.get("pageType")) ?? "",
  url: nonEmpty(formData.get("url")) ?? "",
  title: nonEmpty(formData.get("title")) ?? "",
  seoDescription: nonEmpty(formData.get("seoDescription")),
  socialImage: nonEmpty(formData.get("socialImage")),
});

/**
 * The flagged blocks the editor removed, by base-revision index.
 *
 * The client writes the indices into `removed_blocks` as each flagged block's
 * Remove control is pressed; a form the editor never touched sends an empty
 * value. Bad entries are dropped rather than failing the save.
 */
const removedBlocksFrom = (value: FormDataEntryValue | null): number[] => {
  if (typeof value !== "string" || value.trim() === "") return [];
  const indexes: number[] = [];
  for (const part of value.split(",")) {
    const index = Number.parseInt(part.trim(), 10);
    if (Number.isSafeInteger(index) && index >= 0) indexes.push(index);
  }
  return indexes;
};

export const pages = {
  /** The list of pages and the redirects URL changes have left. */
  async index(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const [pages, pageTypes, redirects] = await Promise.all([
      listPages(),
      listPageTypes(),
      listRedirects(),
    ]);

    const navCsrfToken = await createCsrfToken(
      ctx.sessionId,
      "POST",
      "/auth/logout",
    );

    const notice =
      new URL(req.url).searchParams.get("deleted") === "1"
        ? "Page deleted."
        : null;

    return render(
      <PagesList
        user={ctx.user}
        navCsrfToken={navCsrfToken}
        pages={pages}
        pageTypes={pageTypes}
        redirects={redirects}
        notice={notice}
      />,
    );
  },

  /** The create page: pick a page type and its starting settings. */
  async newPage(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageTypes = (await listPageTypes()).filter(
      (type) => type.removedAt === null,
    );
    const [csrfToken, navCsrfToken] = await Promise.all([
      createCsrfToken(ctx.sessionId, "POST", "/cms/pages/new"),
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
    ]);

    return render(
      <NewPageForm
        user={ctx.user}
        csrfToken={csrfToken}
        navCsrfToken={navCsrfToken}
        pageTypes={pageTypes}
        values={{
          pageType: pageTypes[0]?.name ?? "",
          url: "",
          title: "",
          seoDescription: "",
          socialImage: "",
        }}
      />,
    );
  },

  async create(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: "/cms/pages/new",
    });
    if (!csrf.ok) return csrf.response;

    const formData = await req.formData();
    const settings = settingsFrom(formData);
    const pageTypes = (await listPageTypes()).filter(
      (type) => type.removedAt === null,
    );

    if (settings.pageType === "") {
      const [csrfToken, navCsrfToken] = await Promise.all([
        createCsrfToken(ctx.sessionId, "POST", "/cms/pages/new"),
        createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
      ]);
      return render(
        <NewPageForm
          user={ctx.user}
          csrfToken={csrfToken}
          navCsrfToken={navCsrfToken}
          pageTypes={pageTypes}
          values={{
            ...settings,
            seoDescription: settings.seoDescription ?? "",
            socialImage: settings.socialImage ?? "",
          }}
          errors={[{ path: "pageType", message: "Choose a page type." }]}
        />,
      );
    }

    const result = await createPage(settings);
    if (!result.ok) {
      const [csrfToken, navCsrfToken] = await Promise.all([
        createCsrfToken(ctx.sessionId, "POST", "/cms/pages/new"),
        createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
      ]);
      return render(
        <NewPageForm
          user={ctx.user}
          csrfToken={csrfToken}
          navCsrfToken={navCsrfToken}
          pageTypes={pageTypes}
          values={{
            ...settings,
            seoDescription: settings.seoDescription ?? "",
            socialImage: settings.socialImage ?? "",
          }}
          errors={result.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          }))}
        />,
      );
    }

    return redirect(`/cms/pages/${result.page.id}`);
  },

  /** One page's editor: settings, blocks, and publishing. */
  async form(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const page = await getPageById(pageId);
    if (!page) return render404();

    const pageType = await getPageTypeByName(page.pageType);
    const latest = await getLatestRevision("page", page.id);
    const content = latest ? asPageContent(latest.content).blocks : [];

    return renderPageForm(
      ctx,
      page,
      pageType?.removedAt ? null : pageType,
      content,
      latest?.id ?? null,
      { notice: pageNotice(new URL(req.url).searchParams) },
    );
  },

  /** Save the settings and the content together in one submit. */
  async save(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/pages/${pageId}`,
    });
    if (!csrf.ok && !isRecoverableCsrfFailure(csrf)) return csrf.response;

    const page = await getPageById(pageId);
    if (!page) return render404();

    const pageType = await getPageTypeByName(page.pageType);
    if (!pageType || pageType.removedAt) {
      return renderPageForm(ctx, page, null, [], null);
    }

    const formData = await req.formData();
    const baseRevisionId = nonEmpty(formData.get("base_revision"));
    const removedBlocks = removedBlocksFrom(formData.get("removed_blocks"));
    const submitted = parseContent(formData.get("content"));
    const content: PageBlock[] = submitted.ok
      ? asPageContent(submitted.value).blocks
      : await baseContent(baseRevisionId, page);

    // The page expired while it was open. Re-render what they posted behind a
    // fresh token instead of a 403 that would lose it.
    if (!csrf.ok) {
      return renderPageForm(ctx, page, pageType, content, baseRevisionId, {
        removed: removedBlocks,
        errors: [
          {
            path: "(form)",
            message:
              "This page expired while it was open. Your content is shown below — save again to keep it.",
          },
        ],
      });
    }

    const settings = settingsFrom(formData);
    const pageTypeName =
      settings.pageType === "" ? page.pageType : settings.pageType;
    const typed: PageSettingsInput & { pageType: string } = {
      pageType: pageTypeName,
      url: settings.url,
      title: settings.title,
      seoDescription: settings.seoDescription,
      socialImage: settings.socialImage,
    };

    // Settings and content are validated together and written in one
    // transaction: an invalid block must not leave the URL renamed or a 301
    // behind.
    const result = await savePage({
      pageId: page.id,
      page,
      settings: typed,
      content: { blocks: content },
      baseRevisionId,
      removedBlockIndexes: removedBlocks,
      actorId: ctx.user.id,
    });

    if (!result.ok) {
      // The blocks were checked against the page type the editor chose; render
      // the editor against that type so their work stays in the right shape.
      const formType =
        (await resolveWritablePageType(pageTypeName)) ?? pageType;
      if (result.reason === "conflict") {
        return renderPageForm(
          ctx,
          page,
          formType,
          content,
          result.newer.revisionId,
          { conflict: result.newer, settings: typed, removed: removedBlocks },
        );
      }
      return renderPageForm(ctx, page, formType, content, baseRevisionId, {
        errors: result.issues,
        settings: typed,
        removed: removedBlocks,
      });
    }

    return redirect(`/cms/pages/${page.id}?saved=1`);
  },

  /** The confirm step before a page is deleted. */
  async confirmDelete(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const page = await getPageById(pageId);
    if (!page) return render404();

    const [usage, csrfToken, navCsrfToken] = await Promise.all([
      getPageUsage(page.id),
      createCsrfToken(ctx.sessionId, "POST", `/cms/pages/${page.id}/delete`),
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
    ]);

    return render(
      <PageDeleteConfirm
        user={ctx.user}
        page={page}
        usage={usage}
        csrfToken={csrfToken}
        navCsrfToken={navCsrfToken}
      />,
    );
  },

  async destroy(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/pages/${pageId}/delete`,
    });
    if (!csrf.ok) return csrf.response;

    await deletePage(pageId);
    return redirect("/cms/pages?deleted=1");
  },
};
