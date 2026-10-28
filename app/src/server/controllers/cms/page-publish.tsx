import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import {
  asPageContent,
  getPageById,
  getPageTypeByName,
  getRevisionById,
  listPageHistory,
  publishPage,
  restorePageRevision,
} from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { PageHistory } from "../../templates/cms/page-history";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { renderPageForm } from "./pages";
import { nonEmpty, UUID_PATTERN, warningsParam } from "./params";
import { previewRedirect } from "./preview";

/**
 * Publish and restore for pages, as their own POST endpoints.
 *
 * Separate routes from the save so a refresh repeats a redirect, not the action,
 * and so each carries a CSRF token bound to its own path — a token minted for
 * the form can't be replayed against publish.
 */
export const pagePublish = {
  /**
   * Mint a preview token and open the page on the site with it.
   *
   * A POST, not a link: minting writes a row, and a GET would let any third
   * party (an `<img>`, a link scanner) mint tokens against the CMS by pointing
   * at the URL. The browser follows the redirect to the site, where the plugin
   * finds the token and renders the draft.
   */
  async preview(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/pages/${pageId}/preview`,
    });
    if (!csrf.ok) return csrf.response;

    const page = await getPageById(pageId);
    if (!page) return render404();

    return previewRedirect({
      subjectType: "page",
      subjectId: page.id,
      path: page.url,
      createdBy: ctx.user.id,
      returnTo: `/cms/pages/${page.id}`,
    });
  },

  /** Make a draft the revision the site renders, refusing if a newer one exists. */
  async publish(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/pages/${pageId}/publish`,
    });
    if (!csrf.ok) return csrf.response;

    const page = await getPageById(pageId);
    if (!page) return render404();

    const pageType = await getPageTypeByName(page.pageType);
    if (!pageType || pageType.removedAt) {
      return renderPageForm(ctx, page, null, [], null);
    }

    const formData = await req.formData();
    const revisionId = nonEmpty(formData.get("revision"));
    if (revisionId && !UUID_PATTERN.test(revisionId)) {
      return redirect(`/cms/pages/${pageId}?publish=stale`);
    }

    const result = await publishPage({
      pageId,
      page,
      ...(revisionId ? { revisionId, requireLatest: true } : {}),
    });
    if (!result.ok) {
      if (result.reason === "stale") {
        return redirect(`/cms/pages/${pageId}?publish=stale`);
      }
      if (result.reason === "invalid") {
        const revision = revisionId ? await getRevisionById(revisionId) : null;
        const content = revision ? asPageContent(revision.content).blocks : [];
        return renderPageForm(
          ctx,
          page,
          pageType,
          content,
          revision?.id ?? null,
          {
            errors: result.issues,
            refusedPublish: true,
          },
        );
      }
      // A pending address change lost its URL to another page after the save,
      // so nothing was applied; show the same message a save gives.
      if (result.reason === "duplicate") {
        const revision = revisionId ? await getRevisionById(revisionId) : null;
        const content = revision ? asPageContent(revision.content).blocks : [];
        return renderPageForm(
          ctx,
          page,
          pageType,
          content,
          revision?.id ?? null,
          {
            errors: [result.issue],
            refusedPublish: true,
          },
        );
      }
      return redirect(`/cms/pages/${pageId}?publish=empty`);
    }

    // Only a publish moves the address, so only its redirect carries the old
    // path for the banner. The redirect is written in the same transaction.
    const moved = result.moved
      ? `&moved=${encodeURIComponent(result.moved.from)}`
      : "";
    return redirect(
      `/cms/pages/${pageId}?published=1${moved}${warningsParam(
        result.warnings.length,
      )}`,
    );
  },

  /** Copy a historical revision into a new draft. */
  async restore(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/pages/${pageId}/restore`,
    });
    if (!csrf.ok) return csrf.response;

    const page = await getPageById(pageId);
    if (!page) return render404();

    const formData = await req.formData();
    const revisionId = nonEmpty(formData.get("revision"));
    if (!revisionId) {
      return redirect(`/cms/pages/${pageId}/history?error=missing`);
    }
    if (!UUID_PATTERN.test(revisionId)) {
      return redirect(`/cms/pages/${pageId}/history?error=not-found`);
    }

    const result = await restorePageRevision({
      pageId,
      page,
      revisionId,
      actorId: ctx.user.id,
    });
    if (!result.ok) {
      return redirect(`/cms/pages/${pageId}/history?error=not-found`);
    }

    return redirect(`/cms/pages/${pageId}?restored=1`);
  },

  /** A page's revision history, with a restore button per older revision. */
  async history(req: BunRequest): Promise<Response> {
    const authRedirect = await requireAuth(req);
    if (authRedirect) return authRedirect;

    const ctx = await getSessionContext(req);
    if (!ctx.user || !ctx.sessionId) return redirect("/sign-in");

    const pageId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(pageId)) return render404();

    const page = await getPageById(pageId);
    if (!page) return render404();

    const revisions = await listPageHistory(page);
    const [restoreCsrfToken, navCsrfToken] = await Promise.all([
      createCsrfToken(ctx.sessionId, "POST", `/cms/pages/${page.id}/restore`),
      createCsrfToken(ctx.sessionId, "POST", "/auth/logout"),
    ]);

    const params = new URL(req.url).searchParams;
    const error = params.get("error");
    const notice =
      error === "missing"
        ? "Pick a revision to restore."
        : error === "not-found"
          ? "That revision is no longer available."
          : null;

    return render(
      <PageHistory
        user={ctx.user}
        page={page}
        revisions={revisions}
        restoreCsrfToken={restoreCsrfToken}
        navCsrfToken={navCsrfToken}
        notice={notice}
      />,
    );
  },
};
