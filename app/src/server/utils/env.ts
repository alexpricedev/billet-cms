import { log } from "../services/logger";

const REQUIRED = [
  "DATABASE_URL",
  "CRYPTO_PEPPER",
  "PORT",
  "APP_NAME",
  "APP_URL",
  "EMAIL_PROVIDER",
  "FROM_EMAIL",
  "FROM_NAME",
];

// APP_URL and SITE_URL are both parsed with `new URL()` at request time, so a
// malformed value is a throw on every page render rather than a warning. The
// protocol check is not pedantry: `new URL("mailto:x")` parses happily and its
// `.origin` is the literal string "null", which would ship canonicals reading
// "null/stack". In production `http:` is rejected too — a plaintext canonical is
// a duplicate-content and mixed-content signal, and the emailed links built from
// the same origin would go out unencrypted. Dev and test stay on http://localhost.
//
// Exported so the rule can be tested directly: validateEnv() answers a bad value
// with process.exit(1), which a test can't call without taking the runner down.
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

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (process.env.EMAIL_PROVIDER === "resend" && !process.env.RESEND_API_KEY) {
    missing.push("RESEND_API_KEY");
  }

  if (missing.length > 0) {
    log.error("env", `Missing required variables: ${missing.join(", ")}`);
    log.error(
      "env",
      "Set these in your .env file or environment before starting the server",
    );
    process.exit(1);
  }

  if (
    process.env.EMAIL_PROVIDER === "resend" &&
    (process.env.FROM_EMAIL as string).endsWith("@example.com")
  ) {
    log.error(
      "env",
      "FROM_EMAIL is still the @example.com placeholder — Resend will reject it or it will land in spam",
    );
    log.error(
      "env",
      "Set FROM_EMAIL to an address on a Resend-verified domain (see runbooks/EMAIL.md)",
    );
    process.exit(1);
  }

  // APP_URL is the origin CSRF validation compares against, the base for every
  // emailed link, and — via siteUrl() in services/seo.ts — the canonical origin
  // for canonicals, Open Graph tags, the sitemap and JSON-LD. One bad value now
  // breaks all three, so it is fatal at boot rather than at first render.
  const appUrlProblem = urlProblem("APP_URL", process.env.APP_URL as string);
  if (appUrlProblem) {
    log.error("env", appUrlProblem);
    process.exit(1);
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
      process.exit(1);
    }
  }

  // AUTH_MODE has no place here: the CMS signs users in through the site's own
  // identity view and accepts only magic links for now.

  // TRUST_PROXY decides whose word the rate limiter takes for the client
  // address (see middleware/client-ip.ts). A typo is worth refusing to boot
  // over for the same reason as TEAMS_ENABLED: "ture" silently means "off",
  // and off behind a proxy collapses every client into one rate-limit bucket.
  if (
    process.env.TRUST_PROXY !== undefined &&
    !["true", "false"].includes(process.env.TRUST_PROXY)
  ) {
    log.error(
      "env",
      `TRUST_PROXY must be one of: true, false (got "${process.env.TRUST_PROXY}")`,
    );
    process.exit(1);
  }

  if (process.env.TRUST_PROXY === "true") {
    log.info(
      "env",
      "Trusting x-forwarded-for from the proxy for rate limiting",
    );
  }

  // CAPTCHA_ENABLED is optional and self-contained: the proof-of-work captcha signs
  // challenges with the already-required CRYPTO_PEPPER, so there is no new secret to
  // conditionally require. Just surface that it's on.
  if (process.env.CAPTCHA_ENABLED === "true") {
    log.info("env", "Login captcha enabled (proof-of-work)");
  }

  log.info("env", "Environment variables validated");
}
