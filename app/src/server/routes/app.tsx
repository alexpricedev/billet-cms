import {
  forms,
  home,
  llmsTxt,
  robotsTxt,
  securityTxt,
  sitemap,
  stack,
  webmanifest,
} from "../controllers/app";
import { account, handoff, logout, signIn } from "../controllers/auth";
import {
  dashboard,
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
  "/": home.index,
  "/robots.txt": robotsTxt.index,
  "/site.webmanifest": webmanifest.index,
  "/sitemap.xml": sitemap.index,
  "/llms.txt": llmsTxt.index,
  "/.well-known/security.txt": securityTxt.index,
  "/stack": stack.index,
  "/forms": createRouteHandler({
    GET: forms.index,
    POST: forms.create,
  }),
  // The CMS has no sign-in of its own. A signed-out visitor is sent here, and
  // this route hands them to the site's sign-in route — see `controllers/auth/
  // sign-in.tsx` and the plugin's `handleCmsSignIn`.
  "/sign-in": signIn.index,
  "/account": account.index,
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
  "/cms/pages/:id/restore": createRouteHandler({
    POST: pagePublish.restore,
  }),
  "/cms/pages/:id/delete": createRouteHandler({
    POST: pages.destroy,
  }),
  "/cms/pages/:id/history": pagePublish.history,
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
