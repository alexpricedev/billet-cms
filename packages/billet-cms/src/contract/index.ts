/**
 * The contract between the CMS service and a site's Billet app.
 *
 * Both sides import this module. It is the single source of truth for the
 * version they must agree on, the names of the tables the CMS owns, the keys
 * stored in `cms_meta`, and the shape content definitions take once the site
 * publishes them into the database.
 *
 * The database is the runtime contract, not the source of truth: block and
 * page definitions live in site code and are published into rows on deploy.
 * This module only fixes the parts both services must agree on before that
 * happens.
 */

/**
 * The contract version the CMS writes into `cms_meta.contract_version` and the
 * site's publish step checks before it writes anything.
 *
 * Bump this whenever the stored rows change shape in a way an older site or CMS
 * cannot read. Phase 2 adds the publish-time check; Phase 1 only writes it.
 */
export const CONTRACT_VERSION = "0.1.0";

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
 */
export const TABLES = {
  migrations: "cms_migrations",
  meta: "cms_meta",
  users: "cms_users",
  sessions: "cms_sessions",
  userTokens: "cms_user_tokens",
  identities: "cms_identities",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

/**
 * The keys the CMS keeps in `cms_meta`, alongside any site-specific rows.
 *
 * `contract_version` is written at boot. `content_version` is bumped by the
 * site's publish step and by CMS publishes; the plugin polls it to invalidate
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

export const STORED_SCHEMA_FORMAT_VERSION = 1;

/** Guidance attached to one field, rendered by the CMS when it builds a form. */
export interface FieldMetadata {
  /** The field name as it appears in the block's stored content. */
  name: string;
  /** The vocabulary kind: text, richText, image, link, list, block. */
  kind: string;
  label?: string;
  help?: string;
  required?: boolean;
  /** Present for text fields: the maximum length the editor may type. */
  max?: number;
  /** Present for list fields: how many entries are allowed. */
  min?: number;
}

/** The document published for one block type, slot or page type. */
export interface StoredSchema {
  format: typeof STORED_SCHEMA_FORMAT;
  version: typeof STORED_SCHEMA_FORMAT_VERSION;
  /** The block or page type name, unique within its kind. */
  name: string;
  /** JSON Schema generated from the field vocabulary, used to validate content. */
  jsonSchema: Record<string, unknown>;
  fields: FieldMetadata[];
}
