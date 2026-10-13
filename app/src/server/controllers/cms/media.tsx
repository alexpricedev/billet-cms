/**
 * The media screens: the reuse list, an upload, and one image's detail.
 *
 * Every write goes through the validated media service (`services/media`), so
 * the same checks the library owns — sniffed type, pixel cap, required alt,
 * delete protection — hold whatever the form posted. The controller only moves
 * bytes between the request and the service, and turns the service's issues
 * back into the form.
 */
import { MAX_UPLOAD_BYTES } from "@alexpricedev/billet-cms/contract";
import type { BunRequest } from "bun";
import { getSessionContext, requireAuth } from "../../middleware/auth";
import { checkCsrf } from "../../middleware/csrf";
import { createCsrfToken } from "../../services/csrf";
import {
  createMedia,
  deleteMedia,
  getMediaById,
  getMediaUsage,
  listMedia,
  type MediaIssue,
  type MediaRecord,
  updateMediaAlt,
  updateMediaFocalPoint,
} from "../../services/media";
import type { SessionContext } from "../../services/sessions";
import {
  MediaDeleteConfirm,
  MediaDetail,
  MediaList,
} from "../../templates/cms/media";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { nonEmpty, UUID_PATTERN } from "./params";

const listNotice = (params: URLSearchParams): string | null => {
  if (params.get("uploaded") === "1") return "Image uploaded.";
  if (params.get("deleted") === "1") return "Image deleted.";
  return null;
};

/** Render the library, with a fresh token and whatever the caller wants shown. */
const renderList = async (
  ctx: SessionContext,
  extras: {
    notice?: string | null;
    errors?: MediaIssue[];
    values?: { alt: string };
  } = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const [items, csrfToken, navCsrfToken] = await Promise.all([
    listMedia(),
    createCsrfToken(sessionId, "POST", "/cms/media"),
    createCsrfToken(sessionId, "POST", "/auth/logout"),
  ]);

  return render(
    <MediaList
      user={ctx.user as NonNullable<SessionContext["user"]>}
      csrfToken={csrfToken}
      navCsrfToken={navCsrfToken}
      items={items}
      notice={extras.notice ?? null}
      errors={extras.errors}
      values={extras.values}
    />,
  );
};

const renderDetail = async (
  ctx: SessionContext,
  media: MediaRecord,
  extras: {
    notice?: { kind: "success" | "warning"; message: string } | null;
    errors?: MediaIssue[];
  } = {},
): Promise<Response> => {
  const sessionId = ctx.sessionId as string;
  const [usage, csrfToken, navCsrfToken] = await Promise.all([
    getMediaUsage(media.id),
    createCsrfToken(sessionId, "POST", `/cms/media/${media.id}`),
    createCsrfToken(sessionId, "POST", "/auth/logout"),
  ]);

  return render(
    <MediaDetail
      user={ctx.user as NonNullable<SessionContext["user"]>}
      csrfToken={csrfToken}
      navCsrfToken={navCsrfToken}
      media={media}
      usage={usage}
      notice={extras.notice ?? null}
      errors={extras.errors}
    />,
  );
};

/** The signed-in context every media route needs, or the redirect to get one. */
const context = async (req: BunRequest) => {
  const authRedirect = await requireAuth(req);
  if (authRedirect) return { redirect: authRedirect, ctx: null };
  const ctx = await getSessionContext(req);
  if (!ctx.user || !ctx.sessionId) {
    return { redirect: redirect("/sign-in"), ctx: null };
  }
  return { redirect: null, ctx };
};

export const media = {
  /** The library list and upload form. */
  async index(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    return renderList(ctx, {
      notice: listNotice(new URL(req.url).searchParams),
    });
  },

  /** Accept one upload. */
  async upload(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const csrf = await checkCsrf(req, { method: "POST", path: "/cms/media" });
    if (!csrf.ok) return csrf.response;

    const formData = await req.formData();
    const alt = nonEmpty(formData.get("alt")) ?? "";
    const file = formData.get("file");

    const fail = (message: string): Promise<Response> =>
      renderList(ctx, {
        errors: [{ field: "file", message }],
        values: { alt },
      });

    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose an image to upload.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(
        `That image is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Resize it and try again.`,
      );
    }

    const result = await createMedia({
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType: file.type,
      alt,
      actorId: ctx.user?.id ?? null,
    });

    if (!result.ok) {
      return renderList(ctx, { errors: result.issues, values: { alt } });
    }

    return redirect("/cms/media?uploaded=1");
  },

  /** One image's detail: alt, focal point, uses and delete. */
  async form(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const mediaId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(mediaId)) return render404();

    const image = await getMediaById(mediaId);
    if (!image) return render404();

    const params = new URL(req.url).searchParams;
    const notice =
      params.get("saved") === "1"
        ? { kind: "success" as const, message: "Saved." }
        : params.get("in-use") === "1"
          ? {
              kind: "warning" as const,
              message:
                "That image is used by published content, so it wasn't deleted.",
            }
          : null;

    return renderDetail(ctx, image, { notice });
  },

  /** Save the alt text and the focal point together. */
  async save(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const mediaId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(mediaId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/media/${mediaId}`,
    });
    if (!csrf.ok) return csrf.response;

    const image = await getMediaById(mediaId);
    if (!image) return render404();

    const formData = await req.formData();
    const alt = nonEmpty(formData.get("alt")) ?? "";

    const altResult = await updateMediaAlt(mediaId, alt);
    if (!altResult.ok) {
      return renderDetail(ctx, image, {
        errors: [{ field: "alt", message: altResult.message }],
      });
    }

    const focalX = Number(formData.get("focal_x"));
    const focalY = Number(formData.get("focal_y"));
    const focal = {
      x: Number.isFinite(focalX) ? focalX : image.focalX,
      y: Number.isFinite(focalY) ? focalY : image.focalY,
    };
    const focalResult = await updateMediaFocalPoint(mediaId, focal);
    if (!focalResult.ok) {
      return renderDetail(ctx, altResult.media, {
        errors: [{ field: "file", message: focalResult.message }],
      });
    }

    return redirect(`/cms/media/${mediaId}?saved=1`);
  },

  /** The confirm step before an unused image is deleted. */
  async confirmDelete(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const mediaId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(mediaId)) return render404();

    const image = await getMediaById(mediaId);
    if (!image) return render404();

    // A used image can't be deleted; send the editor back to the detail, which
    // says which pages and slots use it, rather than a confirm that would fail.
    const usage = await getMediaUsage(mediaId);
    if (usage.length > 0) return redirect(`/cms/media/${mediaId}?in-use=1`);

    const sessionId = ctx.sessionId as string;
    const [csrfToken, navCsrfToken] = await Promise.all([
      createCsrfToken(sessionId, "POST", `/cms/media/${mediaId}/delete`),
      createCsrfToken(sessionId, "POST", "/auth/logout"),
    ]);

    return render(
      <MediaDeleteConfirm
        user={ctx.user as NonNullable<SessionContext["user"]>}
        csrfToken={csrfToken}
        navCsrfToken={navCsrfToken}
        media={image}
      />,
    );
  },

  async destroy(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const mediaId = (req.params as { id: string }).id;
    if (!UUID_PATTERN.test(mediaId)) return render404();

    const csrf = await checkCsrf(req, {
      method: "POST",
      path: `/cms/media/${mediaId}/delete`,
    });
    if (!csrf.ok) return csrf.response;

    const result = await deleteMedia(mediaId);
    if (!result.ok) {
      if (result.reason === "not-found") return render404();
      return redirect(`/cms/media/${mediaId}?in-use=1`);
    }

    return redirect("/cms/media?deleted=1");
  },
};
