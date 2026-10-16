import { log } from "../services/logger";

const REQUIRED = [
  "DATABASE_URL",
  "CRYPTO_PEPPER",
  "PORT",
  "APP_NAME",
  "APP_URL",
  "SITE_APP_URL",
];

// APP_URL, SITE_URL and SITE_APP_URL are all parsed with `new URL()` at request
// time, so a malformed value is a throw on every page render rather than a
// warning. The protocol check is not pedantry: `new URL("mailto:x")` parses
// happily and its `.origin` is the literal string "null", which would ship
// canonicals reading "null/cms". In production `http:` is rejected too — a
// plaintext canonical is a duplicate-content and mixed-content signal, and the
// emailed links built from the same origin would go out unencrypted. Dev and
// test stay on http://localhost.
export const urlProblem = (key: string, value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${key} must be an absolute URL including the scheme (got "${value}")`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${key} must use http:// or https:// (got "${value}")`;
  }

  if (parsed.protocol === "http:" && process.env.NODE_ENV === "production") {
    return `${key} must use https:// in production (got "${value}")`;
  }

  return null;
};

/**
 * Refuse to boot on a missing or malformed environment.
 *
 * `exit` defaults to `process.exit` (the process really stops in production);
 * tests inject a recorder so they can assert the refusal without taking the
 * runner down, the same seam `registerShutdown` uses.
 */
export function validateEnv(exit: (code: number) => void = process.exit): void {
  const missing: string[] = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    log.error("env", `Missing required variables: ${missing.join(", ")}`);
    log.error(
      "env",
      "Set these in your .env file or environment before starting the server",
    );
    exit(1);
  }

  // APP_URL is the origin CSRF validation compares against and — via siteUrl()
  // in services/seo.ts — the canonical origin for canonicals, Open Graph tags,
  // the sitemap and JSON-LD. One bad value now breaks all of them, so it is
  // fatal at boot rather than at first render.
  const appUrlProblem = urlProblem("APP_URL", process.env.APP_URL as string);
  if (appUrlProblem) {
    log.error("env", appUrlProblem);
    exit(1);
  }

  // SITE_URL is optional: absent means the canonical origin follows APP_URL,
  // which is right unless the marketing domain and the app domain differ. Set,
  // it is held to the same rule. Blank counts as absent, matching siteUrl() —
  // an empty value is what a copied-out `SITE_URL=` line or a variable cleared
  // on a host that keeps the key leaves behind, and refusing to boot over it
  // would contradict the fallback the rest of the code already applies.
  const configuredSiteUrl = process.env.SITE_URL?.trim();
  if (configuredSiteUrl) {
    const siteUrlProblem = urlProblem("SITE_URL", configuredSiteUrl);
    if (siteUrlProblem) {
      log.error("env", siteUrlProblem);
      exit(1);
    }
  }

  // SITE_APP_URL is the site's own Billet app, where CMS sign-in happens, and it
  // is required: the CMS has no sign-in of its own, so with no site URL it can
  // sign nobody in at all. A missing or blank value is named here rather than
  // left to a service that boots cleanly and then dead-ends every signed-out
  // visit. It is held to the same URL rule as APP_URL, so a bare host or a
  // non-http(s) scheme is fatal too.
  const configuredSiteAppUrl = process.env.SITE_APP_URL?.trim();
  if (!configuredSiteAppUrl) {
    log.error(
      "env",
      "SITE_APP_URL is required — set it to the site's Billet app origin (for example https://example.com)",
    );
    exit(1);
  } else {
    const siteAppUrlProblem = urlProblem("SITE_APP_URL", configuredSiteAppUrl);
    if (siteAppUrlProblem) {
      log.error("env", siteAppUrlProblem);
      exit(1);
    }
  }

  // AUTH_MODE has no place here: the CMS has no sign-in of its own. Signing in
  // always goes through the site — its login, then a single-use handoff token
  // the CMS spends — so whichever mode the site runs is the site's business.

  // TRUST_PROXY decides whose word the rate limiter takes for the client
  // address (see middleware/client-ip.ts). A typo is worth refusing to boot
  // over for the same reason any boolean flag is: "ture" silently means "off",
  // and off behind a proxy collapses every client into one rate-limit bucket.
  if (
    process.env.TRUST_PROXY !== undefined &&
    !["true", "false"].includes(process.env.TRUST_PROXY)
  ) {
    log.error(
      "env",
      `TRUST_PROXY must be one of: true, false (got "${process.env.TRUST_PROXY}")`,
    );
    exit(1);
  }

  if (process.env.TRUST_PROXY === "true") {
    log.info(
      "env",
      "Trusting x-forwarded-for from the proxy for rate limiting",
    );
  }

  log.info("env", "Environment variables validated");
}
