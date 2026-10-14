/**
 * The e2e test site: a minimal Bun server that renders the CMS's content the
 * way a real Billet site would.
 *
 * It is deliberately tiny and imports the plugin by path (the same source a
 * site installs from npm, before this repo publishes it). It serves the slot
 * route — `/`, which renders the declared `home.hero` slot — plus the two routes
 * a real site mounts for CMS sign-in: its own login (`/login`) and the plugin's
 * `/cms/sign-in` handler. There is no CMS API call anywhere: the site reads the
 * shared `cms_` tables through the plugin's helpers, exactly as the spec says,
 * which is why it keeps working when the CMS process is stopped.
 *
 * Preview rides on the same handler: a valid `?cms_preview=` token makes
 * `getSlot` read the newest draft, and `applyPreview` adds the banner and the
 * no-cache headers.
 */
import type { SQL } from "bun";
import { CMS_SIGN_IN_PATH } from "../packages/billet-cms/src/contract/index.ts";
import type { ContentReader } from "../packages/billet-cms/src/server/index.ts";
import {
  applyPreview,
  createCmsMedia,
  createContentReader,
  getPreviewAccess,
  renderCmsImage,
} from "../packages/billet-cms/src/server/index.ts";
import { escapeHtml } from "../packages/billet-cms/src/server/rich-text.ts";
import { handleCmsSignIn } from "../packages/billet-cms/src/sign-in/index.ts";
import { hero } from "./cms.config.ts";

export interface E2eSite {
  /** The request handler, mounted by the test on a real `Bun.serve`. */
  handler: (req: Request) => Promise<Response>;
  /** Drop the reader's cache so a just-published change is picked up at once. */
  invalidate: () => void;
}

export interface E2eSiteOptions {
  /**
   * The CMS origin the sign-in route hands the browser to. A real site reads
   * this from `CMS_URL`; the suite passes the subprocess's port.
   */
  cmsUrl?: string;
}

/**
 * The site's own session cookie. Real sites look their sessions up in Billet's
 * `sessions` table; this stand-in keeps the signed-in user's id in the cookie
 * because the plugin only ever asks the site through `getUserId` — how the site
 * stores a session is its own business.
 */
const SITE_SESSION_COOKIE = "site_session";

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

export const createSite = (sql: SQL, options: E2eSiteOptions = {}): E2eSite => {
  const reader: ContentReader = createContentReader({ sql });
  const mediaReader = createCmsMedia({ sql });

  /**
   * The site's own login: a form that signs a known site user in. A real site
   * runs its own password or magic-link flow here; the suite only needs enough
   * of it that a signed-out editor arrives at the sign-in route with a session.
   */
  const loginPage = (next: string): Response =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        "<title>E2E site login</title></head><body>" +
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
    const rows = (await sql`
      SELECT id FROM users WHERE id = ${id}
    `) as { id: string }[];
    return rows[0]?.id ?? null;
  };

  /**
   * Render the home slot, reading the draft when the request carries a valid
   * preview token (`null` is the published read).
   */
  const renderHome = async (
    preview: Awaited<ReturnType<typeof getPreviewAccess>>,
  ): Promise<string> => {
    const content = await reader.getSlot("home.hero", { block: hero, preview });
    if (!content) return "<h1 data-heading>No content</h1>";

    const heading = escapeHtml(String(content.heading ?? ""));
    let picture = "";
    const photo = content.photo as
      | { mediaId: string; alt?: string }
      | undefined;
    if (photo?.mediaId) {
      const media = await mediaReader.getMedia(photo.mediaId);
      if (media) {
        picture = renderCmsImage(media, photo.alt ? { alt: photo.alt } : {});
      }
    }
    return `<h1 data-heading>${heading}</h1>${picture}`;
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
    if (url.pathname !== "/") return notFound();

    const preview = await getPreviewAccess(sql, req);
    const body = await renderHome(preview);

    const response = new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<title>E2E site</title></head><body>${body}</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
    return applyPreview(response, preview);
  };

  return { handler, invalidate: () => reader.invalidate() };
};
