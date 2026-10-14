import { statsApi } from "../controllers/api";
import { exportApi } from "../controllers/export";
import { createApiRouteHandler } from "../utils/route-handler";

// Every API route goes through `createApiRouteHandler`, including the read-only
// ones: a bare handler in this map answers *every* method, so `/api/stats` used
// to serve its payload to a DELETE.
export const apiRoutes = {
  "/api/stats": createApiRouteHandler({
    GET: statsApi.index,
  }),
  // The export endpoint `cms:pull` calls. Authenticated by an export token, not
  // a session: the caller is a local command, not a browser.
  "/export": createApiRouteHandler({
    GET: exportApi.index,
  }),
};
