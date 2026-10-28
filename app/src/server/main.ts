import { ensureIdentitiesView } from "./database/identity-view";
import { runMigrations } from "./database/migrate";
import { setIpSource } from "./middleware/client-ip";
import { apiRoutes } from "./routes/api";
import { appRoutes } from "./routes/app";
import { mcpRoutes } from "./routes/mcp";
import { initAssets, warnOnMissingDevBundles } from "./services/assets";
import { startCleanupSweep } from "./services/cleanup";
import { closeDatabase } from "./services/database";
import { log } from "./services/logger";
import { validateEnv } from "./utils/env";
import { render500 } from "./utils/errors";
import { handleFallback } from "./utils/fallback";
import { MAX_REQUEST_BODY_BYTES } from "./utils/request-body";
import {
  handleGuarded,
  secureRoutes,
  withSecurityHeaders,
} from "./utils/security-headers";
import { registerShutdown } from "./utils/shutdown";

validateEnv();
await runMigrations();
// After migrations, before serving. Sign-in reads users through this view
// (`services/auth.ts`), so it is created at boot so a site's deploy finds it
// waiting — and skipped while the CMS is deployed before its site, because a
// view over a `users` table that doesn't exist yet is an error.
await ensureIdentitiesView();
await initAssets();
await warnOnMissingDevBundles();

// Not awaited: the first sweep runs alongside the first requests rather than
// delaying the listen.
const stopSweep = startCleanupSweep();

const server = Bun.serve({
  port: Number(process.env.PORT),
  idleTimeout: 30,
  // The upload cap plus multipart framing (`MAX_REQUEST_BODY_BYTES`), so an
  // oversized body is refused with a 413 before it is buffered rather than
  // reaching the media service.
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  routes: {
    // The MCP endpoint and its OAuth discovery surface are machine-facing and
    // live outside `secureRoutes`: they answer JSON-RPC errors, not the CMS's
    // HTML 500, and nothing may buffer their streams. The consent pages inside
    // it opt back in to `handleGuarded`. See `routes/mcp.ts`.
    ...mcpRoutes,
    ...secureRoutes({
      ...appRoutes,
      ...apiRoutes,
    }),
  },
  async fetch(req) {
    return handleGuarded(req, handleFallback);
  },
  // Last-resort backstop for anything the guarded pipeline doesn't catch (e.g.
  // an error thrown in routing itself). Overriding Bun's default also stops its
  // dev error page — which can leak a stack trace — from ever being served. No
  // request is available here, so headers are stamped without compression.
  error() {
    try {
      return withSecurityHeaders(render500());
    } catch {
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

// The rate limiter can't key on the socket address until it can reach
// requestIP, which only exists on the server instance.
setIpSource(server);

registerShutdown({ stopSweep, server, db: { close: closeDatabase } });

log.info("server", `Listening on port ${server.port}`);
