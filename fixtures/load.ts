/**
 * Load the Northwind fixtures into a database, the same way every time.
 *
 * It runs the CMS's migrations, makes the fixture site's `users` table, publishes
 * the site's definitions, and then rewrites the content rows by SQL with fixed
 * ids and timestamps. Nothing here may run against a real site: it truncates
 * `users`. The entry scripts call `assertSandboxSafe` first (and import this
 * file only afterwards, since `app`'s database module opens a pool when loaded);
 * the tests call it directly against the test database.
 *
 * Per-run state — sessions, handoff and preview tokens, the audit log — is
 * cleared, not seeded. `cms_meta.content_version` is pinned, so a running site
 * does not notice a reload on its own: restart it (`bun run sandbox` does).
 */
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";
import { ensureIdentitiesView } from "../app/src/server/database/identity-view.ts";
import { runMigrations } from "../app/src/server/database/migrate.ts";
import { processImage } from "../app/src/server/services/media/processor.ts";
import { createLocalMediaStorage } from "../app/src/server/services/media/storage.ts";
import { siteDefinitions } from "../e2e/cms.config.ts";
import { publish } from "../packages/billet-cms/src/cli/publish/index.ts";
import {
  LIVE_EXPORT_TOKEN,
  REVOKED_EXPORT_TOKEN,
  SANDBOX_PEPPER,
} from "./constants.ts";
import {
  CONTENT_VERSION,
  DEFINITIONS_AT,
  EXPORT_TOKENS,
  PAGES,
  REDIRECTS,
  REVISIONS,
  SLOT_IDS,
  SLOT_PUBLISHED,
} from "./content.ts";
import { IMAGES, renderImage } from "./images.ts";
import { PERSONAS } from "./personas.ts";

export interface LoadOptions {
  sql: SQL;
  /** The fixture site's origin; stored renditions' public URLs sit under it. */
  siteUrl: string;
  /** Where the renditions' files go (the site serves it at `/media/*`). */
  mediaDir: string;
  /** The CMS's `CRYPTO_PEPPER`; token hashes are keyed with it. */
  pepper?: string;
}

/** The tables the loader owns and empties. `users` is the fixture site's own. */
const RESET_TABLES = [
  "cms_audit",
  "cms_export_tokens",
  "cms_media",
  "cms_redirects",
  "cms_pages",
  "cms_preview_tokens",
  "cms_handoff_tokens",
  "cms_revisions",
  "cms_user_tokens",
  "cms_sessions",
  "cms_block_types",
  "cms_page_types",
  "cms_slots",
  "users",
] as const;

/** Every table `dumpFixtureTables` reads, for the "load twice" comparison. */
export const FIXTURE_TABLES = [
  "users",
  "cms_block_types",
  "cms_page_types",
  "cms_slots",
  "cms_revisions",
  "cms_pages",
  "cms_redirects",
  "cms_media",
  "cms_export_tokens",
  "cms_meta",
] as const;

const hmac = (pepper: string, value: string): string =>
  createHmac("sha256", pepper).update(value).digest("hex");

const fixedId = (prefix: string, n: number): string =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const loadFixtures = async (options: LoadOptions): Promise<void> => {
  const { sql, siteUrl, mediaDir } = options;
  const pepper = options.pepper ?? SANDBOX_PEPPER;

  // The site's own table has to exist before the CMS view over it is made.
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      role VARCHAR(20) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin'))
    )
  `;
  await runMigrations(sql);
  await ensureIdentitiesView(sql);

  await sql.unsafe(
    `TRUNCATE TABLE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );

  for (const person of PERSONAS) {
    await sql`
      INSERT INTO users (id, email, role, created_at)
      VALUES (${person.id}, ${person.email}, ${person.role}, ${DEFINITIONS_AT})
    `;
  }

  // Deploy the site's declarations the way `billet-cms-publish` does, then pin
  // the ids and timestamps the publish minted.
  await publish(sql, siteDefinitions);
  const definitionTables = [
    "cms_block_types",
    "cms_page_types",
    "cms_slots",
  ] as const;
  for (const [index, table] of definitionTables.entries()) {
    const names = (await sql.unsafe(
      `SELECT name FROM ${table} ORDER BY name`,
    )) as { name: string }[];
    for (const [position, { name }] of names.entries()) {
      // Slots keep the ids the content below points at.
      const id =
        table === "cms_slots"
          ? SLOT_IDS[name as keyof typeof SLOT_IDS]
          : fixedId(`7${index}000000`, position + 1);
      await sql.unsafe(
        `UPDATE ${table} SET id = $1, created_at = $2, updated_at = $2 WHERE name = $3`,
        [id, DEFINITIONS_AT, name],
      );
    }
  }

  // Media: the real processor, so renditions and keys match an upload's.
  await rm(join(mediaDir, "media"), { recursive: true, force: true });
  const storage = createLocalMediaStorage(mediaDir, `${siteUrl}/media`);
  for (const image of IMAGES) {
    const processed = await processImage(await renderImage(image), "jpeg");
    const objectKey = `media/${image.id}/original.${processed.original.extension}`;
    await storage.put(
      objectKey,
      processed.original.bytes,
      processed.original.contentType,
    );
    const variants = [];
    for (const rendition of processed.renditions) {
      const webpKey = `media/${image.id}/${rendition.width}.webp`;
      const fallbackKey = `media/${image.id}/${rendition.width}.${rendition.fallbackExtension}`;
      await storage.put(webpKey, rendition.webp, "image/webp");
      await storage.put(
        fallbackKey,
        rendition.fallback,
        rendition.fallbackContentType,
      );
      variants.push({
        width: rendition.width,
        height: rendition.height,
        webpKey,
        webpUrl: storage.publicUrl(webpKey),
        fallbackKey,
        fallbackUrl: storage.publicUrl(fallbackKey),
      });
    }
    const uploader = PERSONAS.find((p) => p.key === image.uploadedBy)?.id;
    await sql`
      INSERT INTO cms_media
        (id, object_key, content_type, byte_size, width, height, alt,
         focal_x, focal_y, variants, created_by, created_at, updated_at)
      VALUES (
        ${image.id}, ${objectKey}, ${processed.original.contentType},
        ${processed.original.bytes.length}, ${processed.width},
        ${processed.height}, ${image.alt}, ${image.focal.x}, ${image.focal.y},
        ${variants}, ${uploader}, ${image.uploadedAt}, ${image.uploadedAt}
      )
    `;
  }

  for (const revision of REVISIONS) {
    await sql`
      INSERT INTO cms_revisions
        (id, target_type, target_id, content, created_by, created_at)
      VALUES (
        ${revision.id}, ${revision.targetType}, ${revision.targetId},
        ${revision.content}, ${revision.createdBy}, ${revision.createdAt}
      )
    `;
  }

  for (const page of PAGES) {
    await sql`
      INSERT INTO cms_pages
        (id, page_type, url, title, seo_description, published_revision_id,
         created_at, updated_at)
      VALUES (
        ${page.id}, ${page.pageType}, ${page.url}, ${page.title},
        ${page.seoDescription}, ${page.publishedRevisionId},
        ${page.createdAt}, ${page.updatedAt}
      )
    `;
  }

  for (const redirect of REDIRECTS) {
    await sql`
      INSERT INTO cms_redirects (id, from_path, to_page_id, created_at)
      VALUES (${redirect.id}, ${redirect.fromPath}, ${redirect.toPageId},
              ${redirect.createdAt})
    `;
  }

  for (const [name, revisionId] of Object.entries(SLOT_PUBLISHED)) {
    await sql`
      UPDATE cms_slots SET published_revision_id = ${revisionId}
      WHERE name = ${name}
    `;
  }

  for (const token of EXPORT_TOKENS) {
    const raw = token.live ? LIVE_EXPORT_TOKEN : REVOKED_EXPORT_TOKEN;
    await sql`
      INSERT INTO cms_export_tokens
        (id, label, token_hash, created_by, created_at, last_used_at, revoked_at)
      VALUES (
        ${token.id}, ${token.label}, ${hmac(pepper, raw)}, ${token.createdBy},
        ${token.createdAt}, ${token.lastUsedAt}, ${token.revokedAt}
      )
    `;
  }

  await sql`
    UPDATE cms_meta
    SET content_version = ${CONTENT_VERSION}, updated_at = ${DEFINITIONS_AT}
    WHERE id = 1
  `;
};

/**
 * Every fixture table as ordered JSON, for comparing two loads. Rows are ordered
 * by primary key, with columns as the database returns them: none is volatile.
 */
export const dumpFixtureTables = async (
  sql: SQL,
): Promise<Record<string, unknown[]>> => {
  const dump: Record<string, unknown[]> = {};
  for (const table of FIXTURE_TABLES) {
    dump[table] = JSON.parse(
      JSON.stringify(await sql.unsafe(`SELECT * FROM ${table} ORDER BY id`)),
    );
  }
  return dump;
};
