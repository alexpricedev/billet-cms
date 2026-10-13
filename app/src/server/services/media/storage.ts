/**
 * Where an upload's bytes live: an S3-compatible bucket, behind one small
 * interface (Q5).
 *
 * The code is S3-generic; a Railway bucket is just the first deployment. Bun's
 * own S3 client speaks the protocol, so there is no SDK to add and the
 * credentials are read from the environment the same way an SDK would read
 * them. `MEDIA_PUBLIC_BASE_URL` is what turns an object key into the URL a
 * page renders; it is separate from the API endpoint because a bucket's public
 * host (a custom domain, a Railway public URL) is rarely the same as where the
 * CMS writes.
 *
 * Tests never touch a bucket: `createMemoryMediaStorage` holds the bytes in a
 * map and hands back a URL under a fake host, so the whole pipeline is
 * exercised without network or credentials.
 */

export interface MediaStorage {
  /** Store `body` under `key`. Overwrites. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Remove `key`. Missing keys are not an error. */
  delete(key: string): Promise<void>;
  /** The public URL a page renders for `key`. */
  publicUrl(key: string): string;
}

const joinUrl = (base: string, key: string): string =>
  `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;

export interface S3StorageConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  sessionToken?: string;
  /** The origin public objects are served from, e.g. a Railway bucket URL. */
  publicBaseUrl: string;
}

/** A bucket, via Bun's S3 client. */
export const createS3MediaStorage = (config: S3StorageConfig): MediaStorage => {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.region ? { region: config.region } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  });

  return {
    async put(key, body, contentType) {
      await client.write(key, body, { type: contentType });
    },
    async delete(key) {
      await client.unlink(key);
    },
    publicUrl(key) {
      return joinUrl(config.publicBaseUrl, key);
    },
  };
};

export interface MemoryMediaStorage extends MediaStorage {
  readonly objects: Map<string, { body: Uint8Array; contentType: string }>;
}

/** The in-process storage tests use. Never configured in production. */
export const createMemoryMediaStorage = (
  publicBaseUrl = "https://media.test",
): MemoryMediaStorage => {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key, body, contentType) {
      objects.set(key, { body: body.slice(), contentType });
    },
    async delete(key) {
      objects.delete(key);
    },
    publicUrl(key) {
      return joinUrl(publicBaseUrl, key);
    },
  };
};

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * The bucket configuration, or `null` when it isn't set.
 *
 * All of the API credentials plus a public base URL are required together:
 * storing bytes the site can't then load (no public URL) is worse than refusing
 * the upload with a clear message. Region and endpoint stay optional so an AWS
 * deployment needs neither and an S3-compatible one sets only the endpoint.
 */
export const mediaStorageConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): S3StorageConfig | null => {
  const bucket = nonEmpty(env.S3_BUCKET);
  const accessKeyId = nonEmpty(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.S3_SECRET_ACCESS_KEY);
  const publicBaseUrl = nonEmpty(env.MEDIA_PUBLIC_BASE_URL);

  if (!bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl)
    return null;

  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    ...(nonEmpty(env.S3_REGION) ? { region: env.S3_REGION as string } : {}),
    ...(nonEmpty(env.S3_ENDPOINT)
      ? { endpoint: env.S3_ENDPOINT as string }
      : {}),
    ...(nonEmpty(env.S3_SESSION_TOKEN)
      ? { sessionToken: env.S3_SESSION_TOKEN as string }
      : {}),
  };
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
    const config = mediaStorageConfigFromEnv(env);
    configured = config ? createS3MediaStorage(config) : null;
  }
  return configured;
};

/** Point the process at a storage for one test, without a bucket. */
export const setMediaStorageForTest = (
  storage: MediaStorage | null | undefined,
): void => {
  override = storage;
};

/** Drop the memoised storage and any test override. */
export const resetMediaStorageForTest = (): void => {
  configured = undefined;
  override = undefined;
};
