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
 * cannot read. Phase 2 adds the publish-time check, the field vocabulary and
 * the definition tables; it moved the stored field metadata from a flat list to
 * a tree, so a Phase 1 CMS cannot read a Phase 2 publish.
 */
export const CONTRACT_VERSION = "0.2.0";

/**
 * Every relation the CMS creates is prefixed with this, so a CMS instance can
 * share a database with the site it serves without either one clashing with the
 * other's tables, sequences, indexes or constraints.
 */
export const TABLE_PREFIX = "cms_";

/**
 * Every table and view the CMS owns.
 *
 * `identities` is a view, not a table: the CMS does not own user accounts. The
 * default definition reads the site's own `users` table and the CMS creates it
 * only when it is missing, so a site can replace it with one that exposes
 * editor roles.
 *
 * `block_types`, `page_types` and `slots` hold what a site's deploy publishes:
 * the JSON Schema and field metadata the CMS builds its forms from, and the
 * page type rules (allowed blocks, required blocks, limits).
 */
export const TABLES = {
  migrations: "cms_migrations",
  meta: "cms_meta",
  users: "cms_users",
  sessions: "cms_sessions",
  userTokens: "cms_user_tokens",
  identities: "cms_identities",
  blockTypes: "cms_block_types",
  pageTypes: "cms_page_types",
  slots: "cms_slots",
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
 * Callers pass a value they build in a fixed key order.
 */
export const hashJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
