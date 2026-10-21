/**
 * Where an upload's bytes live: an S3-compatible bucket, behind one small
 * interface (Q5).
 *
 * The drivers come from `@alexpricedev/billet-storage`: its S3 driver (Bun's
 * own client, so no SDK), its disk driver for the sandbox, and its memory
 * driver for tests. What stays here is the CMS's own choice of driver, which
 * is stricter than the package's `storageFromEnv`: with no bucket configured
 * the CMS refuses uploads with a message rather than writing to disk, and the
 * variables keep their `MEDIA_` names. `MEDIA_PUBLIC_BASE_URL` is what turns an
 * object key into the URL a page renders; it is separate from the API endpoint
 * because a bucket's public host (a custom domain, a Railway public URL) is
 * rarely the same as where the CMS writes.
 *
 * Tests never touch a bucket: the package's `createMemoryStorage` holds the
 * bytes in a map and hands back a URL under a fake host, so the whole pipeline
 * is exercised without network or credentials.
 */
import {
  createDiskStorage,
  createS3Storage,
  type PublicStorage,
  type S3StorageConfig,
  s3ConfigFromEnv,
} from "@alexpricedev/billet-storage";
import { httpUrl } from "../../utils/http-origin";
import { log } from "../logger";

/**
 * Every store the CMS uses has a public URL: the site renders each rendition
 * straight from it.
 */
export type MediaStorage = PublicStorage;

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

// One warning per process. The config is read wherever storage is used, and a
// bad value should be reported once, not on every upload the CMS attempts.
let warnedInvalidPublicBaseUrl = false;

const warnInvalidPublicBaseUrl = (value: string): void => {
  if (warnedInvalidPublicBaseUrl) return;
  warnedInvalidPublicBaseUrl = true;
  log.warn(
    "media",
    `MEDIA_PUBLIC_BASE_URL is set but is not an absolute http(s) URL (${value}); treating it as unset, so uploads are refused.`,
  );
};

/**
 * The bucket configuration, or `null` when it isn't set.
 *
 * All of the API credentials plus a public base URL are required together:
 * storing bytes the site can't then load (no public URL) is worse than refusing
 * the upload with a clear message. Region and endpoint stay optional so an AWS
 * deployment needs neither and an S3-compatible one sets only the endpoint.
 *
 * `MEDIA_PUBLIC_BASE_URL` is checked by the shared http(s) rule
 * (`utils/http-origin`) rather than a local copy, because it becomes every
 * stored rendition's public URL — rendered into pages and the CSP `img-src` —
 * so a bare host, a relative path or a `javascript:`/`data:` value must not
 * reach either. A value that is set but rejected is warned about once, so a
 * typo does not turn every upload into a silent refusal.
 */
export const mediaStorageConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): (S3StorageConfig & { publicBaseUrl: string }) | null => {
  const configuredBaseUrl = nonEmpty(env.MEDIA_PUBLIC_BASE_URL);
  const publicBaseUrl =
    configuredBaseUrl && httpUrl(configuredBaseUrl) ? configuredBaseUrl : null;
  if (configuredBaseUrl && !publicBaseUrl)
    warnInvalidPublicBaseUrl(configuredBaseUrl);

  // Some but not all of the bucket variables is, to the package, a mistake to
  // throw on; to the CMS it is the same "uploads aren't set up" as none, so the
  // editor gets the message rather than the CMS failing to render a page.
  let s3: S3StorageConfig | null;
  try {
    s3 = s3ConfigFromEnv(env);
  } catch {
    return null;
  }
  if (!s3 || !publicBaseUrl) return null;

  return { ...s3, publicBaseUrl };
};

let configured: MediaStorage | null | undefined;
let override: MediaStorage | null | undefined;

/**
 * The process-wide storage, built from the environment on first use.
 *
 * `null` means uploads aren't configured; the media service reports that to the
 * editor rather than failing a page render, so a site that never uploads an
 * image still runs with no bucket variables set.
 */
export const getMediaStorage = (
  env: Record<string, string | undefined> = process.env,
): MediaStorage | null => {
  if (override !== undefined) return override;
  if (configured === undefined) {
    const localDir = nonEmpty(env.MEDIA_LOCAL_DIR);
    const baseUrl = nonEmpty(env.MEDIA_PUBLIC_BASE_URL);
    const production = env.NODE_ENV === "production";
    if (localDir && production) {
      log.warn(
        "media",
        "MEDIA_LOCAL_DIR is for development and tests only; ignoring it in production.",
      );
    }
    if (localDir && !production && baseUrl && httpUrl(baseUrl)) {
      configured = createDiskStorage({
        dir: localDir,
        publicBaseUrl: baseUrl,
        env,
      });
    } else {
      const config = mediaStorageConfigFromEnv(env);
      configured = config ? createS3Storage(config) : null;
    }
  }
  return configured;
};

/** Point the process at a storage for one test, without a bucket. */
export const setMediaStorageForTest = (
  storage: MediaStorage | null | undefined,
): void => {
  override = storage;
};

/** Drop the memoised storage, any test override, and the one-time warning. */
export const resetMediaStorageForTest = (): void => {
  configured = undefined;
  override = undefined;
  warnedInvalidPublicBaseUrl = false;
};
