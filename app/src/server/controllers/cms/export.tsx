/**
 * The export tokens screen.
 *
 * An admin creates a token here, copies it once, and uses it with `cms:pull`.
 * Every write goes through `services/export/tokens`, so the same rules the
 * screen shows — a required label, a revocable token, the one-time raw value —
 * hold whatever the form posted. The raw token is rendered into the create
 * response and never stored. The form carries a one-use nonce, so reloading
 * that response re-posts a spent nonce: it creates nothing and says the token
 * was shown once, instead of quietly minting a second one.
 */
import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import { createCsrfToken } from "../../services/csrf";
import {
  createExportToken,
  createExportTokenNonce,
  ExportTokenLabelError,
  listExportTokens,
  revokeExportToken,
} from "../../services/export";
import type { SessionContext } from "../../services/sessions";
import { ExportPage } from "../../templates/cms/export";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { nonEmpty, UUID_PATTERN } from "./params";

const renderPage = async (
  ctx: SessionContext,
  extras: {
    newToken?: string | null;
    notice?: string | null;
    /** Defaults to success; a spent nonce is a warning, not an outcome. */
    noticeTone?: "success" | "warning";
    error?: string | null;
    /** Response headers the page itself needs, e.g. `no-store`. */
    headers?: Record<string, string>;
  } = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const tokens = await listExportTokens();
  const [createCsrfToken_, navCsrfToken] = await Promise.all([
    createCsrfToken(sessionId, "POST", "/cms/export"),
    createCsrfToken(sessionId, "POST", "/auth/logout"),
  ]);
  const revokeCsrfTokens: Record<string, string> = {};
  for (const token of tokens) {
    if (token.revokedAt) continue;
    revokeCsrfTokens[token.id] = await createCsrfToken(
      sessionId,
      "POST",
      `/cms/export/${token.id}/revoke`,
    );
  }

  return render(
    <ExportPage
      user={ctx.user as NonNullable<SessionContext["user"]>}
      navCsrfToken={navCsrfToken}
      createCsrfToken={createCsrfToken_}
      // Fresh on every render, so a page re-rendered after a label error still
      // has an unspent form and the service refuses only a genuine replay.
      nonce={createExportTokenNonce()}
      revokeCsrfTokens={revokeCsrfTokens}
      tokens={tokens}
      newToken={extras.newToken ?? null}
      notice={extras.notice ?? null}
      noticeTone={extras.noticeTone}
      error={extras.error ?? null}
    />,
    extras.headers,
  );
};

/** The signed-in context every export route needs, or the redirect to get one. */
const context = async (req: BunRequest) => {
  const authRedirect = await requireAuth(req);
  if (authRedirect) return { redirect: authRedirect, ctx: null };
  const ctx = await getSessionContext(req);
  if (!ctx.user || !ctx.sessionId) {
    return { redirect: redirect("/sign-in"), ctx: null };
  }
  return { redirect: null, ctx };
};

export const exportTokens = {
  /** The token list and the create form. */
  async index(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const params = new URL(req.url).searchParams;
    return renderPage(ctx, {
      notice: params.get("revoked") === "1" ? "Token revoked." : null,
    });
  },

  /**
   * Create a token and show its raw value once.
   *
   * Deliberately not a redirect: the raw token exists only in this response, so
   * a POST-redirect-GET would throw it away before the admin could copy it.
   * The form's nonce is what makes a reload of this response safe: the second
   * post replays a spent nonce, writes nothing and shows the page with a note
   * instead of a second token.
   */
  async create(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const csrf = await checkCsrf(req, { method: "POST", path: "/cms/export" });
    if (!csrf.ok) return csrf.response;

    const formData = await req.formData();
    const label = nonEmpty(formData.get("label"))?.trim() ?? "";
    const nonce = String(formData.get("nonce") ?? "");

    let created: Awaited<ReturnType<typeof createExportToken>>;
    try {
      created = await createExportToken({
        label,
        nonce,
        actorId: ctx.user?.id ?? null,
      });
    } catch (error) {
      if (error instanceof ExportTokenLabelError) {
        return renderPage(ctx, { error: error.message });
      }
      throw error;
    }

    if (!created.ok) {
      if (created.reason === "nonce-used") {
        return renderPage(ctx, {
          notice: "This token was shown once. Create another if you lost it.",
          noticeTone: "warning",
        });
      }
      return renderPage(ctx, {
        error: "This form is out of date. Reload the page and try again.",
      });
    }

    // The raw token is in this body and nowhere else, so the response must not
    // be stored by a proxy, a shared cache or the browser's back-forward cache.
    return renderPage(ctx, {
      newToken: created.rawToken,
      headers: { "Cache-Control": "no-store" },
    });
  },

  /** Revoke a token. */
  async revoke(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const tokenId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(tokenId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/export/${tokenId}/revoke`,
    });
    if (!csrf.ok) return csrf.response;

    const result = await revokeExportToken(tokenId, ctx.user?.id ?? null);
    if (!result.ok) return render404();

    return redirect("/cms/export?revoked=1");
  },
};
