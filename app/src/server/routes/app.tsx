import {
  landing,
  llmsTxt,
  robotsTxt,
  securityTxt,
  sitemap,
  webmanifest,
} from "../controllers/app";
import { account, handoff, logout, signIn } from "../controllers/auth";
import {
  connectedApps,
  dashboard,
  exportTokens,
  media,
  pagePublish,
  pages,
  slotForm,
  slotHistory,
  slotPublish,
} from "../controllers/cms";
import { createRouteHandler } from "../utils/route-handler";

// `/health` is not here: it is answered by the catch-all fallback so it stays
// up when the database is down. See `handleFallback`.
export const appRoutes = {
  // The CMS root is a redirect, not a page: the bare origin goes to the CMS
  // surface, which is guarded, so a signed-out visitor is handed to the site's
  // sign-in route. See `controllers/app/landing.ts`.
  "/": landing.index,
  "/robots.txt": robotsTxt.index,
  "/site.webmanifest": webmanifest.index,
  "/sitemap.xml": sitemap.index,
  "/llms.txt": llmsTxt.index,
  "/.well-known/security.txt": securityTxt.index,
  // The CMS has no sign-in of its own. A signed-out visitor is sent here, and
  // this route hands them to the site's sign-in route — see `controllers/auth/
  // sign-in.tsx` and the plugin's `handleCmsSignIn`.
  "/sign-in": signIn.index,
  "/account": account.index,
  // The account page's Theme card. Its own path so the CSRF token is bound to
  // the form that minted it, and a save redirects back to the page.
  "/account/theme": createRouteHandler({
    POST: account.saveTheme,
  }),
  // The CMS's own surface. /cms lists the pages and slots a site published;
  // /cms/slots/:id is the generated editor for one slot, with publish and
  // history alongside it. Each write is its own path so a refresh repeats a
  // redirect, and carries a CSRF token bound to that path.
  "/cms": dashboard.index,
  "/cms/slots/:id": createRouteHandler({
    GET: slotForm.index,
    POST: slotForm.create,
  }),
  "/cms/slots/:id/publish": createRouteHandler({
    POST: slotPublish.publish,
  }),
  "/cms/slots/:id/preview": createRouteHandler({
    POST: slotPublish.preview,
  }),
  "/cms/slots/:id/restore": createRouteHandler({
    POST: slotPublish.restore,
  }),
  "/cms/slots/:id/history": slotHistory.index,
  // The CMS's own pages: created against a page type, served by the site's
  // catch-all at their URL, with the 301 a rename writes shown alongside.
  // `/cms/pages/new` is declared so the static segment wins over `:id`.
  "/cms/pages": pages.index,
  "/cms/pages/new": createRouteHandler({
    GET: pages.newPage,
    POST: pages.create,
  }),
  "/cms/pages/:id": createRouteHandler({
    GET: pages.form,
    POST: pages.save,
  }),
  "/cms/pages/:id/publish": createRouteHandler({
    POST: pagePublish.publish,
  }),
  "/cms/pages/:id/preview": createRouteHandler({
    POST: pagePublish.preview,
  }),
  "/cms/pages/:id/restore": createRouteHandler({
    POST: pagePublish.restore,
  }),
  "/cms/pages/:id/delete": createRouteHandler({
    GET: pages.confirmDelete,
    POST: pages.destroy,
  }),
  "/cms/pages/:id/history": pagePublish.history,
  // The media library: the reuse list and one upload form, then an image's own
  // detail (alt, focal point, uses, delete). `/cms/media/:id/delete` is
  // declared after `:id` but Bun matches the longer path first; both are real
  // paths, not a catch-all.
  "/cms/media": createRouteHandler({
    GET: media.index,
    POST: media.upload,
  }),
  // The image picker's JSON options. Declared beside the library it pages; a
  // static segment, so it wins over `/cms/media/:id` whatever the order.
  "/cms/media/options": createRouteHandler({
    GET: media.options,
  }),
  "/cms/media/:id": createRouteHandler({
    GET: media.form,
    POST: media.save,
  }),
  "/cms/media/:id/delete": createRouteHandler({
    GET: media.confirmDelete,
    POST: media.destroy,
  }),
  // Export tokens: admin-created credentials for `cms:pull`. A create shows the
  // raw token once (no redirect), and a revoke retires the row in place.
  "/cms/export": createRouteHandler({
    GET: exportTokens.index,
    POST: exportTokens.create,
  }),
  "/cms/export/:id/revoke": createRouteHandler({
    POST: exportTokens.revoke,
  }),
  // Connected apps: the OAuth grants on this CMS. A revoke is a POST with its
  // own CSRF token and disconnects the client immediately; the row stays as
  // history rather than being deleted.
  "/cms/mcp": connectedApps.index,
  "/cms/mcp/:id/revoke": createRouteHandler({
    POST: connectedApps.revoke,
  }),
  // The Edit content handoff and CMS sign-in both arrive as a single-use token
  // the site minted, so both render a confirm step on GET and spend the token on
  // POST: a token a browser prefetch or a link scanner could burn by fetching
  // the URL would otherwise leave the person staring at a dead link.
  "/handoff": createRouteHandler({
    GET: handoff.index,
    POST: handoff.create,
  }),
  "/auth/logout": createRouteHandler({
    POST: logout.create,
  }),
};
