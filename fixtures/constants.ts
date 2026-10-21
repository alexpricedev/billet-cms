/**
 * Values the sandbox pins so that two runs, and the cookies a script prints,
 * mean the same thing. None of them is a secret: they exist only in a sandbox
 * database, and the guards stop the sandbox pointing anywhere else.
 */
import { join } from "node:path";

/** Shared by the CMS, the loader and `persona-session`: it keys every HMAC. */
export const SANDBOX_PEPPER = "sandbox-pepper-do-not-use-in-production";

/** Distinct from the site's cookie: cookies are not scoped by port on localhost. */
export const CMS_COOKIE_NAME = "northwind_cms_session";

export const DEFAULT_CMS_PORT = 3000;
export const DEFAULT_SITE_PORT = 3001;

/** Where the CMS writes uploads and the site serves them from. */
export const DEFAULT_MEDIA_DIR = join(
  import.meta.dir,
  "..",
  ".sandbox",
  "media",
);

/** The raw value of the live export token (story 10 pulls with it). */
export const LIVE_EXPORT_TOKEN = "nw-live-export-token-0123456789abcdef";
export const REVOKED_EXPORT_TOKEN = "nw-revoked-export-token-fedcba9876543210";
