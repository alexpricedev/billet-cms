/**
 * The contract between the CMS service and a site's Billet app.
 *
 * Both sides import this module. It is the single source of truth for the
 * version they must agree on, the names of the tables the CMS owns, the keys
 * stored in `cms_meta`, and the shape definitions take once the site publishes
 * them into the database.
 *
 * The database is the runtime contract, not the source of truth: block and
 * page definitions live in site code and are published into rows on deploy.
 * This module only fixes the parts both services must agree on before that
 * happens.
 */
import { createHash } from "node:crypto";

/**
 * The contract version the CMS writes into `cms_meta.contract_version` and the
 * site's publish step checks before it writes anything.
 *
 * Bump this whenever the stored rows change shape in a way an older site or CMS
 * cannot read. Phase 2 added the publish-time check, the field vocabulary and
 * the definition tables; it moved the stored field metadata from a flat list to
 * a tree, so a Phase 1 CMS cannot read a Phase 2 publish. Phase 3 adds the
 * revisions a CMS save writes, the published-revision pointer on `cms_slots`
 * and the single-use handoff tokens a site mints for the Edit content link and
 * CMS sign-in, and drops `cms_users` — sign-in now reads the site's own accounts through
 * `cms_identities` — so an older CMS cannot read a Phase 3 database. Phase 5 adds
 * `cms_pages` (the pages an editor creates against a page type) and `cms_redirects`
 * (the 301s a URL change writes), so the site's catch-all and the plugin's page
 * reader need both before they can serve a page at its URL. Phase 6 adds
 * `cms_preview_tokens` (the short-lived, single-subject tokens the CMS mints and
 * the plugin checks to render drafts) and `cms_slots.preview_path` (the site page
 * a slot lives on, so the CMS's Preview button opens the real page), so an older
 * CMS cannot mint or read a preview. Phase 7 adds `cms_media` (the uploads an
 * editor reuses, with their renditions and focal point) and its stored variant
 * shape, so a site that reads an image through the plugin needs both before it
 * can render one.
 */
export const CONTRACT_VERSION = "0.6.0";

/**
 * Every relation the CMS creates is prefixed with this, so a CMS instance can
 * share a database with the site it serves without either one clashing with the
 * other's tables, sequences, indexes or constraints.
 */
export const TABLE_PREFIX = "cms_";

/**
 * The path on the **site** that starts a CMS sign-in.
 *
 * The CMS has no sign-in of its own: a signed-out visit is sent to
 * `<SITE_APP_URL>${CMS_SIGN_IN_PATH}`, a route the site mounts from the plugin
 * (`handleCmsSignIn`). That route mints a single-use handoff token and sends the
 * browser back to the CMS, which spends it — the same mechanism as the Edit
 * content link, and no shared secret between the two services. Fixing the path
 * here is what lets both sides agree on it without importing each other.
 */
export const CMS_SIGN_IN_PATH = "/cms/sign-in";

/**
 * The query parameter the CMS puts a preview token in, and the plugin reads.
 *
 * The token is what turns a normal published read into a draft read on the
 * *site*, so the parameter is part of the contract: the CMS builds the URL, the
 * plugin parses it, and neither imports the other.
 */
export const PREVIEW_QUERY_PARAM = "cms_preview";

/** How long a preview token lives: about half an hour. */
export const PREVIEW_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * The fixed widths the CMS generates for every upload, in pixels (Phase 7).
 *
 * Never an upscale: a width wider than the source is skipped, and the source
 * width itself is added when it sits above the widest fixed one, so the largest
 * rendition is always the source's own size. The site's `<CmsImage>` builds a
 * `srcset` from whatever variants the row carries, so both sides agree on the
 * ladder without either importing the other.
 */
export const MEDIA_WIDTHS = [480, 960, 1600, 2400] as const;

/** The largest upload the CMS accepts, in bytes — about 20 MB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * The most pixels the CMS will decode.
 *
 * The source's dimensions are read from its header before Sharp touches it, so
 * a decompression bomb — a small file that expands to an enormous bitmap — is
 * refused before it can allocate that memory. 100 MP is far above any real
 * photograph and far below what would exhaust a container.
 */
export const MAX_UPLOAD_PIXELS = 100_000_000;

/**
 * The source types the CMS accepts.
 *
 * SVG is refused: it can carry scripts, and serving one from the bucket would
 * be stored XSS on a page that embedded it. GIF is refused too, animated or
 * not — it is not in the accepted set, and an animated GIF would be flattened
 * to a single frame by the conversion anyway.
 */
export const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** The focal point a new upload starts at: the centre. */
export const DEFAULT_FOCAL_POINT = { x: 0.5, y: 0.5 } as const;

/** Where the focal point sits on the image, each axis a fraction from 0 to 1. */
export interface FocalPoint {
  x: number;
  y: number;
}

/**
 * One rendition of an upload, as stored on `cms_media.variants`.
 *
 * `key` is the object key the CMS deletes; `url` is the public URL `<CmsImage>`
 * renders. Both are stored rather than derived so the site needs no bucket
 * configuration and an export carries working URLs.
 */
export interface MediaVariant {
  width: number;
  height: number;
  /** Object key of the WebP rendition. */
  webpKey: string;
  /** Public URL of the WebP rendition. */
  webpUrl: string;
  /** Object key of the fallback rendition (JPEG, or PNG for a PNG source). */
  fallbackKey: string;
  /** Public URL of the fallback rendition. */
  fallbackUrl: string;
}

/**
 * Every table and view the CMS owns.
 *
 * `identities` is a view, not a table: the CMS does not own user accounts. The
 * default definition reads the site's own `users` table and the CMS creates it
 * only when it is missing, so a site can replace it with one that exposes
 * editor roles. Sign-in and every session read through it; there is no
 * `cms_users` table (Phase 3 dropped it).
 *
 * `block_types`, `page_types` and `slots` hold what a site's deploy publishes:
 * the JSON Schema and field metadata the CMS builds its forms from, and the
 * page type rules (allowed blocks, required blocks, limits).
 *
 * `revisions` is where every save lands: one immutable row per draft, keyed by
 * the page or slot it belongs to. `handoff_tokens` carries the single-use
 * tokens a site mints, written by the plugin and spent by the CMS — the Edit
 * content link and the CMS sign-in route both use it, so the CMS can hand a
 * signed-in site admin a session without a shared secret.
 *
 * `pages` is the CMS's own content: one row per page an editor created against
 * a page type, with its settings (URL, title, SEO description, social image)
 * and a pointer at the published revision. `redirects` is what a page's URL
 * change writes — the old path points at the page id, so it survives a second
 * rename and the site's catch-all answers it before it looks for a page.
 *
 * `preview_tokens` is the other half of Preview: the CMS mints a short-lived,
 * single-subject token (one page or one slot) and opens the site with it in the
 * query string; the plugin reads the row to decide whether to render drafts. It
 * is never listed, revoked row by row or single-use — it expires after half an
 * hour and a sweep deletes it.
 *
 * `media` is the uploads library: one row per stored image, carrying its size,
 * its renditions and its focal point. An `image()` field stores only a
 * `mediaId`, so the site reads the row through the plugin's `<CmsImage>` and
 * gets the picture's dimensions, `srcset` and `object-position` back.
 */
export const TABLES = {
  migrations: "cms_migrations",
  meta: "cms_meta",
  sessions: "cms_sessions",
  userTokens: "cms_user_tokens",
  identities: "cms_identities",
  blockTypes: "cms_block_types",
  pageTypes: "cms_page_types",
  slots: "cms_slots",
  revisions: "cms_revisions",
  handoffTokens: "cms_handoff_tokens",
  pages: "cms_pages",
  redirects: "cms_redirects",
  previewTokens: "cms_preview_tokens",
  media: "cms_media",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

/**
 * The keys the CMS keeps in `cms_meta`, alongside any site-specific rows.
 *
 * `contract_version` is written at boot. `content_version` is bumped whenever
 * published definitions or content change; the plugin polls it to invalidate
 * its in-memory cache within seconds.
 */
export const META_KEYS = {
  contractVersion: "contract_version",
  contentVersion: "content_version",
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

const TABLES_BY_NAME: ReadonlyMap<string, TableName> = new Map(
  Object.values(TABLES).map((name) => [name, name]),
);

/** True when `name` is a relation the CMS owns. */
export const isCmsRelation = (name: string): boolean =>
  TABLES_BY_NAME.has(name) || name.startsWith(TABLE_PREFIX);

/**
 * How a published definition is stored.
 *
 * The site's deploy publishes block types, slots and page types as a Zod
 * schema flattened to JSON Schema plus per-field metadata (labels, help text,
 * limits, image guidance). `format` identifies the document and `version` is
 * the format's own version, so a document written by an older publish can be
 * recognised and either read or flagged.
 */
export const STORED_SCHEMA_FORMAT = "billet-cms/schema";

export const STORED_SCHEMA_FORMAT_VERSION = 2;

/** The vocabulary kind of a field, used to pick the CMS's form control. */
export type FieldKind = "text" | "richText" | "image" | "link" | "list";

/** Upload guidance for an image field, checked by the CMS when an editor uploads. */
export interface ImageGuidance {
  /** The smallest source width the field accepts, in pixels. */
  minWidth?: number;
  /** The preferred aspect ratio, e.g. `"16:9"`. */
  aspect?: string;
}

/**
 * Guidance attached to one field, rendered by the CMS when it builds a form.
 *
 * This is the "field metadata tree": a `list` carries the metadata of its item
 * under `of`, so a form can render a repeatable control without the CMS ever
 * importing site code.
 */
export interface FieldMetadata {
  /** The field name as it appears in the block's stored content. */
  name: string;
  /** The vocabulary kind: text, richText, image, link or list. */
  kind: FieldKind;
  label?: string;
  help?: string;
  /** Whether the field must be present in stored content. */
  required: boolean;
  /** Present for text fields (characters) and list fields (entries). */
  max?: number;
  /** Present for list fields: the fewest entries allowed. */
  min?: number;
  /** Present for image fields: the upload guidance. */
  image?: ImageGuidance;
  /** Present for list fields: the metadata of the repeated item. */
  of?: FieldMetadata;
}

/** The document published for one block type. */
export interface StoredSchema {
  format: typeof STORED_SCHEMA_FORMAT;
  version: typeof STORED_SCHEMA_FORMAT_VERSION;
  /** The block type name, unique within its kind. */
  name: string;
  /** JSON Schema generated from the field vocabulary, used to validate content. */
  jsonSchema: Record<string, unknown>;
  /** The field metadata tree, used to build the editor's form. */
  fields: FieldMetadata[];
  /** SHA-256 of `jsonSchema` and `fields`, for change detection on re-publish. */
  schemaHash: string;
}

/** How many of a block a page type allows, and where it may sit. */
export interface BlockLimit {
  max?: number;
  min?: number;
  position?: "top" | "bottom" | "any";
}

/** The document published for one page type. */
export interface StoredPageType {
  format: typeof STORED_SCHEMA_FORMAT;
  version: typeof STORED_SCHEMA_FORMAT_VERSION;
  name: string;
  label?: string;
  help?: string;
  /** The block type names a page of this type may contain. */
  allowedBlocks: string[];
  /** The block type names a page of this type must contain. */
  requiredBlocks: string[];
  /** Per-block limits, keyed by block type name. */
  limits: Record<string, BlockLimit>;
  /** JSON Schema for a page's content, generated from the allowed blocks. */
  jsonSchema: Record<string, unknown>;
  /** SHA-256 of the definition, for change detection on re-publish. */
  schemaHash: string;
}

/**
 * Stable SHA-256 of a JSON-serialisable value.
 *
 * Used as the schema hash a re-publish compares against the stored row: two
 * deploys that declare the same thing produce the same hash and write nothing.
 * Object keys are sorted recursively first, so the hash depends on the values
 * alone and not on the order a deploy happened to build them in.
 */
export const hashJson = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");

/**
 * A copy of `value` with every object's keys sorted.
 *
 * Arrays keep their order — it is meaningful — while objects are rebuilt with
 * their keys in lexical order at every depth, so two structurally equal values
 * serialise identically. `JSON.stringify` drops an `undefined` value, so an
 * absent optional property and one set to `undefined` hash the same.
 */
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])]),
  );
};
