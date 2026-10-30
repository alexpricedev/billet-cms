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
  listMediaOptionsPage,
  MEDIA_PICKER_LIMIT,
  type MediaIssue,
  type MediaRecord,
  updateMedia,
} from "../../services/media";
import type { SessionContext } from "../../services/sessions";
import {
  GRID_THUMBNAIL_WIDTH,
  MediaDeleteConfirm,
  MediaDetail,
  MediaList,
  variantForDisplay,
} from "../../templates/cms/media";
import { render404 } from "../../utils/errors";
import { redirect, render } from "../../utils/response";
import { nonEmpty, UUID_PATTERN } from "./params";

/**
 * The JSON shape a picker sees for one upload.
 *
 * The thumbnail is sized for the same card the library page uses
 * (`GRID_THUMBNAIL_WIDTH` in `templates/cms/media`), so the picker doesn't
 * download a full rendition per tile.
 */
const optionJson = (
  option: Pick<MediaRecord, "id" | "alt" | "width" | "height" | "variants">,
) => ({
  id: option.id,
  alt: option.alt,
  width: option.width,
  height: option.height,
  thumbnailUrl:
    variantForDisplay(option, GRID_THUMBNAIL_WIDTH)?.fallbackUrl ?? null,
});

/**
 * Whether the caller asked for JSON rather than a page.
 *
 * The picker's drop zone posts the same multipart form the library page does,
 * but it can't use a redirect: each file's outcome has to land on that file's
 * tile. `Accept` is the contract, so a browser form post — which sends
 * `text/html` — keeps the redirect it always had.
 */
const acceptsJson = (req: BunRequest): boolean =>
  (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");

const listNotice = (params: URLSearchParams): string | null => {
  if (params.get("uploaded") === "1") return "Image uploaded.";
  if (params.get("deleted") === "1") return "Image deleted.";
  return null;
};

/**
 * A focal fraction from the form, or `null` when the field is absent or isn't a
 * number.
 *
 * Both inputs are always rendered, but a request can omit or blank them.
 * `Number(null)` and `Number("")` are `0`, which would silently pin the focal
 * point to the top-left instead of leaving it as it was; the caller falls back
 * to the stored value on `null`.
 */
const focalFraction = (value: FormDataEntryValue | null): number | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  /**
   * The picker's options, as JSON: one page of uploads newest first.
   *
   * Same guard as every other media route, so a signed-out request is sent to
   * sign in. `q` filters the alt text and `after` is the opaque cursor the
   * previous page returned; see `listMediaOptionsPage`.
   */
  async options(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const params = new URL(req.url).searchParams;
    const page = await listMediaOptionsPage({
      q: params.get("q"),
      after: params.get("after"),
      limit: MEDIA_PICKER_LIMIT,
    });

    return Response.json({
      items: page.items.map(optionJson),
      next: page.next,
    });
  },

  /** Accept one upload. */
  async upload(req: BunRequest): Promise<Response> {
    const { redirect: authRedirect, ctx } = await context(req);
    if (authRedirect || !ctx) return authRedirect ?? render404();

    const csrf = await checkCsrf(req, { method: "POST", path: "/cms/media" });
    if (!csrf.ok) return csrf.response;

    const json = acceptsJson(req);
    const formData = await req.formData();
    const alt = nonEmpty(formData.get("alt")) ?? "";
    const file = formData.get("file");

    // The page answers a refused upload by re-rendering the library with the
    // message; the picker can't be navigated to, so it gets the same issue as
    // JSON and puts it on the file's own tile.
    const fail = (message: string): Response | Promise<Response> =>
      json
        ? Response.json(
            { errors: [{ field: "file", message }] },
            { status: 400 },
          )
        : renderList(ctx, {
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
      return json
        ? Response.json({ errors: result.issues }, { status: 400 })
        : renderList(ctx, { errors: result.issues, values: { alt } });
    }

    return json
      ? Response.json(optionJson(result.media))
      : redirect("/cms/media?uploaded=1");
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

    const focal = {
      x: focalFraction(formData.get("focal_x")) ?? image.focalX,
      y: focalFraction(formData.get("focal_y")) ?? image.focalY,
    };

    // One write and one `content_version` bump, not two: the site's cache sees
    // the new alt and the new crop together.
    const result = await updateMedia(mediaId, { alt, focal });
    if (!result.ok) {
      return renderDetail(ctx, image, {
        errors: [{ field: "alt", message: result.message }],
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
