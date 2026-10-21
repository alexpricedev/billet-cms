/**
 * The test site: a minimal Bun server that renders the CMS's content the way a
 * real Billet site would. The e2e suite drives it, and the sandbox runs it as
 * Northwind Studio (`fixtures/`), the site the UX stories are written against.
 *
 * It is deliberately tiny and imports the plugin by path (the same source a
 * site installs from npm, before this repo publishes it). It serves the slots
 * (`home.hero` and `footer.cta` on `/`), every published CMS page and redirect
 * through the plugin's catch-all, `/media/*` from a local directory when one is
 * configured, plus the two routes a real site mounts for CMS sign-in: its own
 * login (`/login`) and the plugin's `/cms/sign-in` handler. There is no CMS API
 * call anywhere: the site reads the shared `cms_` tables through the plugin's
 * helpers, exactly as the spec says, which is why it keeps working when the CMS
 * process is stopped.
 *
 * Preview rides on the same handlers: a valid `?cms_preview=` token makes
 * `getSlot` and `getPage` read the newest draft, and `applyPreview` adds the
 * banner and the no-cache headers.
 */
import { join, resolve, sep } from "node:path";
import type { SQL } from "bun";
import { CMS_SIGN_IN_PATH } from "../packages/billet-cms/src/contract/index.ts";
import type { RichTextDocument } from "../packages/billet-cms/src/fields/index.ts";
import type {
  CmsMediaReader,
  CmsPageBlock,
  CmsPagesReader,
  ContentReader,
  PreviewAccess,
} from "../packages/billet-cms/src/server/index.ts";
import {
  applyPreview,
  createCmsMedia,
  createCmsPageRoute,
  createCmsPages,
  createContentReader,
  getPreviewAccess,
  renderCmsImage,
  renderRichText,
} from "../packages/billet-cms/src/server/index.ts";
import { escapeHtml } from "../packages/billet-cms/src/server/rich-text.ts";
import { handleCmsSignIn } from "../packages/billet-cms/src/sign-in/index.ts";
import { cta, hero } from "./cms.config.ts";

export interface E2eSite {
  /** The request handler, mounted by the test on a real `Bun.serve`. */
  handler: (req: Request) => Promise<Response>;
  /** Drop the readers' caches so a just-published change is picked up at once. */
  invalidate: () => void;
}

export interface E2eSiteOptions {
  /**
   * The CMS origin the sign-in route hands the browser to. A real site reads
   * this from `CMS_URL`; the suite passes the subprocess's port.
   */
  cmsUrl?: string;
  /**
   * A directory to serve at `/media/*`: the local-disk media store the sandbox
   * gives the CMS in place of a bucket. Unset, `/media/*` is a 404.
   */
  mediaDir?: string;
}

/**
 * The site's own session cookie. Real sites look their sessions up in Billet's
 * `sessions` table; this stand-in keeps the signed-in user's id in the cookie
 * because the plugin only ever asks the site through `getUserId` — how the site
 * stores a session is its own business.
 */
export const SITE_SESSION_COOKIE = "site_session";

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

const readCookie = (req: Request, name: string): string | null => {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
};

/** Keep the return path on this site, so the login can't be an open redirect. */
const safeNext = (value: string): string =>
  value.startsWith("/") && !value.startsWith("//") ? value : "/";

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#222}" +
  "header,main,footer{max-width:48rem;margin:0 auto;padding:1rem}" +
  "nav a{margin-right:1rem}img{max-width:100%;height:auto}" +
  "section{margin:2rem 0}h1{overflow-wrap:anywhere}";

/** A site page's chrome. Plain on purpose: it exists to be edited. */
const layout = (title: string, body: string, footer = ""): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>` +
  `<header><nav><a href="/">Northwind Studio</a>` +
  `<a href="/about">About</a><a href="/work">Work</a>` +
  `<a href="${CMS_SIGN_IN_PATH}">Edit content</a></nav></header>` +
  `<main>${body}</main><footer>${footer}</footer></body></html>`;

export const createSite = (sql: SQL, options: E2eSiteOptions = {}): E2eSite => {
  const reader: ContentReader = createContentReader({ sql });
  const mediaReader: CmsMediaReader = createCmsMedia({ sql });
  const pagesReader: CmsPagesReader = createCmsPages({ sql });

  /**
   * The site's own login: a form that signs a known site user in. A real site
   * runs its own password or magic-link flow here; the suite only needs enough
   * of it that a signed-out editor arrives at the sign-in route with a session.
   */
  const loginPage = (next: string): Response =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        "<title>Site login</title></head><body>" +
        `<form method="post" action="/login">` +
        `<input type="hidden" name="next" value="${escapeHtml(next)}">` +
        `<label>Email <input type="email" name="email"></label> ` +
        `<button type="submit">Sign in</button>` +
        "</form></body></html>",
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );

  const logIn = async (req: Request): Promise<Response> => {
    const form = await req.formData();
    const email = String(form.get("email") ?? "");
    const next = safeNext(String(form.get("next") ?? "/"));

    const rows = (await sql`
      SELECT id FROM users WHERE email = ${email}
    `) as { id: string }[];
    const user = rows[0];
    if (!user) return new Response("Unknown email", { status: 401 });

    return new Response("", {
      status: 303,
      headers: {
        Location: next,
        "Set-Cookie": `${SITE_SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax`,
      },
    });
  };

  /**
   * The site's half of CMS sign-in: resolve the site's own signed-in user and
   * hand it to the plugin, which checks `cms_identities` and mints the handoff
   * token. A signed-out visitor is sent to the site's own login and back.
   */
  const getUserId = async (req: Request): Promise<string | null> => {
    const id = readCookie(req, SITE_SESSION_COOKIE);
    if (!id) return null;
    // Confirm the account still exists, the way a real session lookup would, so
    // a stale cookie from a deleted user is signed out rather than carried on.
    // A cookie that isn't a UUID can't match a row (and would fail the cast).
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = (await sql`
      SELECT id FROM users WHERE id = ${id}
    `) as { id: string }[];
    return rows[0]?.id ?? null;
  };

  /** An image field's value as `<picture>` markup, or "" when it can't render. */
  const renderImage = async (value: unknown): Promise<string> => {
    const photo = value as { mediaId?: string; alt?: string } | undefined;
    if (!photo?.mediaId) return "";
    const media = await mediaReader.getMedia(photo.mediaId);
    if (!media) return "";
    return renderCmsImage(media, photo.alt ? { alt: photo.alt } : {});
  };

  /** A stored link as an anchor, or "" when its page is gone. */
  const renderLink = async (
    value: unknown,
    fallback: string,
  ): Promise<string> => {
    const link = value as
      | { type: "page" | "url"; label?: string; url?: string; pageId?: string }
      | undefined;
    if (!link) return "";
    const href = await pagesReader.resolveLink(
      link as Parameters<CmsPagesReader["resolveLink"]>[0],
    );
    if (!href) return "";
    return `<a href="${escapeHtml(href)}">${escapeHtml(link.label || fallback)}</a>`;
  };

  /** One block of a page, or of a slot (`type` names the block either way). */
  const renderBlock = async (block: CmsPageBlock): Promise<string> => {
    switch (block.type) {
      case "hero":
        return (
          `<section data-block="hero"><h1 data-heading>` +
          `${escapeHtml(String(block.heading ?? ""))}</h1>` +
          `${await renderImage(block.photo)}</section>`
        );
      case "text":
        return `<section data-block="text">${renderRichText(block.body as RichTextDocument)}</section>`;
      case "gallery": {
        const images = Array.isArray(block.images) ? block.images : [];
        const rendered = await Promise.all(images.map(renderImage));
        return `<section data-block="gallery">${rendered.join("")}</section>`;
      }
      case "quote":
        return (
          `<section data-block="quote"><blockquote>` +
          `${escapeHtml(String(block.text ?? ""))}` +
          `<footer>${escapeHtml(String(block.attribution ?? ""))}</footer>` +
          `</blockquote>${await renderLink(block.link, "Read more")}</section>`
        );
      case "cta":
        return (
          `<section data-block="cta"><h2>` +
          `${escapeHtml(String(block.heading ?? ""))}</h2>` +
          `${await renderLink(block.link, "Get in touch")}</section>`
        );
      default:
        return "";
    }
  };

  /** The footer slot, on every page. A draft only shows for its own preview. */
  const renderFooter = async (
    preview: PreviewAccess | null,
  ): Promise<string> => {
    const content = await reader.getSlot("footer.cta", { block: cta, preview });
    return content ? await renderBlock({ type: "cta", ...content }) : "";
  };

  /**
   * Render the home slot, reading the draft when the request carries a valid
   * preview token (`null` is the published read).
   */
  const renderHome = async (preview: PreviewAccess | null): Promise<string> => {
    const content = await reader.getSlot("home.hero", { block: hero, preview });
    if (!content) return "<h1 data-heading>No content</h1>";
    return await renderBlock({ type: "hero", ...content });
  };

  const pageRoute = createCmsPageRoute({
    sql,
    reader: pagesReader,
    render: async (page, { preview }) => {
      const blocks = await Promise.all(page.blocks.map(renderBlock));
      return html(
        layout(
          page.title,
          `<h1 data-page-title>${escapeHtml(page.title)}</h1>${blocks.join("")}`,
          await renderFooter(preview),
        ),
      );
    },
  });

  const serveMedia = async (pathname: string): Promise<Response> => {
    if (!options.mediaDir) return notFound();
    const root = resolve(options.mediaDir);
    let key: string;
    try {
      key = decodeURIComponent(pathname.slice("/media/".length));
    } catch {
      return notFound();
    }
    const target = resolve(join(root, key));
    if (!target.startsWith(`${root}${sep}`)) return notFound();
    const file = Bun.file(target);
    if (!(await file.exists())) return notFound();
    const type = CONTENT_TYPES[target.split(".").pop()?.toLowerCase() ?? ""];
    return new Response(file, {
      headers: {
        "Content-Type": type ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/login") {
      if (req.method === "GET" || req.method === "HEAD") {
        return loginPage(safeNext(url.searchParams.get("next") ?? "/"));
      }
      if (req.method === "POST") return logIn(req);
      return notFound();
    }

    if (url.pathname === CMS_SIGN_IN_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return notFound();
      return handleCmsSignIn(req, {
        sql,
        cmsUrl: options.cmsUrl,
        getUserId,
      });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return notFound();

    if (url.pathname.startsWith("/media/")) return serveMedia(url.pathname);

    if (url.pathname === "/") {
      const preview = await getPreviewAccess(sql, req);
      const body = await renderHome(preview);
      const footer = await renderFooter(preview);
      const response = html(layout("Northwind Studio", body, footer));
      return applyPreview(response, preview);
    }

    // Redirects, then published pages (and previewed drafts).
    const routed = await pageRoute(req);
    if (routed) return routed;
    return notFound();
  };

  return {
    handler,
    // A hard reset of every reader, not just the slot one: a just-published
    // image change (or any content the media reader caches) has to be dropped
    // too, or the site would keep serving the media it last read until
    // `content_version` happens to move.
    invalidate: () => {
      reader.invalidate();
      mediaReader.invalidate();
      pagesReader.invalidate();
    },
  };
};
