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
import { account, callback, handoff, login, logout } from "../controllers/auth";
import { dashboard, slotForm } from "../controllers/cms";
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
  "/login": createRouteHandler({
    GET: login.index,
    POST: login.create,
  }),
  "/account": account.index,
  // The CMS's own surface. /cms lists the pages and slots a site published;
  // /cms/slots/:id is the generated editor for one slot.
  "/cms": dashboard.index,
  "/cms/slots/:id": createRouteHandler({
    GET: slotForm.index,
    POST: slotForm.create,
  }),
  // Both of these arrive as a link in an email, so both render a confirm step
  // on GET and spend the token on POST: a single-use token a mail scanner can
  // burn by fetching the link is a token the recipient never gets to use.
  "/auth/callback": createRouteHandler({
    GET: callback.index,
    POST: callback.create,
  }),
  // The Edit content handoff: a link the site mints, spent here. Same
  // GET-confirm/POST-spend shape, for the same single-use-token reason.
  "/handoff": createRouteHandler({
    GET: handoff.index,
    POST: handoff.create,
  }),
  "/auth/logout": createRouteHandler({
    POST: logout.create,
  }),
};
