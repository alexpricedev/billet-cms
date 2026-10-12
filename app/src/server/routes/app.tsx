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
  // The CMS has no sign-in of its own. A signed-out visitor is sent here, and
  // this route hands them to the site's sign-in route — see `controllers/auth/
  // sign-in.tsx` and the plugin's `handleCmsSignIn`.
  "/sign-in": signIn.index,
  "/account": account.index,
  // The CMS's own surface. /cms lists the pages and slots a site published;
  // /cms/slots/:id is the generated editor for one slot.
  "/cms": dashboard.index,
  "/cms/slots/:id": createRouteHandler({
    GET: slotForm.index,
    POST: slotForm.create,
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
