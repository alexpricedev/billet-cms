/**
 * The e2e test site: a minimal Bun server that renders the CMS's content the
 * way a real Billet site would.
 *
 * It is deliberately tiny and imports the plugin by path (the same source a
 * site installs from npm, before this repo publishes it). It serves one route —
 * `/`, which renders the declared `home.hero` slot — plus a 404. There is no
 * CMS API call anywhere: the site reads the shared `cms_` tables through the
 * plugin's helpers, exactly as the spec says, which is why it keeps working
 * when the CMS process is stopped.
 *
 * Preview rides on the same handler: a valid `?cms_preview=` token makes
 * `getSlot` read the newest draft, and `applyPreview` adds the banner and the
 * no-cache headers.
 */
import type { SQL } from "bun";
import {
  applyPreview,
  createCmsMedia,
  createContentReader,
  getPreviewAccess,
  renderCmsImage,
} from "../packages/billet-cms/src/server/index.ts";
import { escapeHtml } from "../packages/billet-cms/src/server/rich-text.ts";
import { hero } from "./cms.config.ts";

export interface E2eSite {
  /** The request handler, mounted by the test on a real `Bun.serve`. */
  handler: (req: Request) => Promise<Response>;
  /** Drop the reader's cache so a just-published change is picked up at once. */
  invalidate: () => void;
}

const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

export const createSite = (sql: SQL): E2eSite => {
  const reader = createContentReader({ sql });
  const mediaReader = createCmsMedia({ sql });

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
