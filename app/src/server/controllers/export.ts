/**
 * `GET /export`: the read-only export endpoint `cms:pull` calls.
 *
 * It is authenticated by an export token — `Authorization: Bearer …` — and by
 * nothing else: no session, no cookie, no CSRF, because the caller is a local
 * command, not a browser. A missing or unknown token is a 401 with the shared
 * JSON error envelope; a revoked one is indistinguishable from an unknown one,
 * which is deliberate.
 *
 * The response is the whole export document (`services/export`), which carries
 * published content only. The token's id is stamped into `cms_audit` on every
 * read, so an operator can see who pulled and when.
 */
import type { BunRequest } from "bun";
import { recordAudit } from "../services/audit";
import { buildExport } from "../services/export/export";
import { verifyExportToken } from "../services/export/tokens";
import { jsonError } from "../utils/response";

/** The raw token out of an `Authorization: Bearer …` header, or `null`. */
export const readBearerToken = (header: string | null): string | null => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token === "" ? null : token;
};

export const exportApi = {
  async index(req: BunRequest): Promise<Response> {
    const rawToken = readBearerToken(req.headers.get("authorization"));
    if (!rawToken) {
      return jsonError(
        401,
        "unauthorized",
        "An export token is required: send `Authorization: Bearer <token>`.",
      );
    }

    const token = await verifyExportToken(rawToken);
    if (!token) {
      return jsonError(
        401,
        "invalid_token",
        "That export token is unknown or has been revoked.",
      );
    }

    const document = await buildExport();

    await recordAudit({
      action: "export.read",
      actorId: token.id,
      subjectType: "export_token",
      subjectId: token.id,
      detail: {
        label: token.label,
        pages: document.pages.length,
        slots: document.slots.length,
        media: document.media.length,
      },
    });

    return Response.json(document);
  },
};
