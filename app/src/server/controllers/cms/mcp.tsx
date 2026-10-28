/**
 * Connected apps: the OAuth grants on this CMS.
 *
 * A grant is one consent — a client, the person who approved it, and the one
 * scope this CMS issues. Revoking it stops every access and refresh token it
 * ever issued at the next request; the row stays as history, which is why the
 * page shows revoked grants separately rather than deleting them.
 */
import type { BunRequest } from "bun";
import { isMcpEnabled } from "../../mcp/config";
import { mcpResource } from "../../mcp/oauth/config";
import { listGrants, revokeGrant } from "../../mcp/oauth/tokens";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import { createCsrfToken } from "../../services/csrf";
import type { SessionContext } from "../../services/sessions";
import { McpPage } from "../../templates/cms/mcp";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { UUID_PATTERN } from "./params";

const REVOKE_PATH = (id: string) => `/cms/mcp/${id}/revoke`;

const renderPage = async (
  ctx: SessionContext,
  extras: {
    notice?: string | null;
    error?: string | null;
  } = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const grants = await listGrants();
  const navCsrfToken = await createCsrfToken(sessionId, "POST", "/auth/logout");

  const revokeCsrfTokens: Record<string, string> = {};
  for (const grant of grants) {
    if (grant.revokedAt) continue;
    revokeCsrfTokens[grant.id] = await createCsrfToken(
      sessionId,
      "POST",
      REVOKE_PATH(grant.id),
    );
  }

  return render(
    <McpPage
      user={ctx.user as NonNullable<SessionContext["user"]>}
      navCsrfToken={navCsrfToken}
      revokeCsrfTokens={revokeCsrfTokens}
      grants={grants}
      serverUrl={mcpResource()}
      notice={extras.notice ?? null}
      error={extras.error ?? null}
    />,
  );
};

const context = async (req: BunRequest) => {
  const authRedirect = await requireAuth(req);
  if (authRedirect) return { redirect: authRedirect, ctx: null };
  const ctx = await getSessionContext(req);
  if (!ctx.user || !ctx.sessionId) {
    return { redirect: redirect("/sign-in"), ctx: null };
  }
  return { redirect: null, ctx };
};

export const connectedApps = {
  /** The grants list and the revoke controls. */
  async index(req: BunRequest): Promise<Response> {
    if (!isMcpEnabled()) return render404();

    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const params = new URL(req.url).searchParams;
    return renderPage(ctx, {
      notice: params.get("revoked") === "1" ? "App disconnected." : null,
    });
  },

  /** Revoke one grant; the client loses access immediately. */
  async revoke(req: BunRequest): Promise<Response> {
    if (!isMcpEnabled()) return render404();

    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const grantId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(grantId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: REVOKE_PATH(grantId),
    });
    if (!csrf.ok) return csrf.response;

    const revoked = await revokeGrant(grantId, ctx.user?.id ?? null);
    if (!revoked) return render404();

    return redirect("/cms/mcp?revoked=1");
  },
};
