/** Ports, origins and cookie names for the sandbox, from the environment. */
import {
  CMS_COOKIE_NAME,
  DEFAULT_CMS_PORT,
  DEFAULT_MEDIA_DIR,
  DEFAULT_SITE_PORT,
} from "../fixtures/constants.ts";

export const sandboxConfig = (env: Record<string, string | undefined>) => {
  const cmsPort = Number(env.SANDBOX_CMS_PORT ?? DEFAULT_CMS_PORT);
  const sitePort = Number(env.SANDBOX_SITE_PORT ?? DEFAULT_SITE_PORT);
  return {
    cmsPort,
    sitePort,
    cmsUrl: `http://localhost:${cmsPort}`,
    siteUrl: `http://localhost:${sitePort}`,
    mediaDir: env.SANDBOX_MEDIA_DIR ?? DEFAULT_MEDIA_DIR,
    cmsCookieName: CMS_COOKIE_NAME,
  };
};
