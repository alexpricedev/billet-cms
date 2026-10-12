/**
 * Publish a site's definitions into the CMS's tables on deploy.
 *
 * The site is the source of truth; the database is the runtime contract. This
 * runs once per deploy, writes the block types, page types and slots the site
 * declares, and marks anything a previous deploy declared but this one no
 * longer does as `removed_at` — never deleting it (Q4), so saved content keeps
 * pointing at a row and the CMS can flag what no longer validates.
 *
 * Re-publishing the same definitions writes nothing: each stored document
 * carries a schema hash the next publish compares against, so an unchanged
 * deploy leaves `content_version` alone and the site's cache stays warm.
 */
import type { SQL } from "bun";
import { type StoredPageType, type StoredSchema, TABLES } from "../../contract";
import {
  type BlockDefinitionShape,
  blockStoredSchema,
  type PageTypeDefinition,
  pageTypeStoredSchema,
  type SlotDefinition,
} from "../../fields";
import { assertContractVersion, CmsNotSetUpError } from "./version";

/** Everything a site's config module declares. */
export interface SiteDefinitions {
  blocks?: readonly BlockDefinitionShape[];
  slots?: readonly SlotDefinition[];
  pageTypes?: readonly PageTypeDefinition[];
}

/** What one publish did, for the CLI's summary and the tests' assertions. */
export interface PublishSummary {
  blocks: number;
  pageTypes: number;
  slots: number;
  removedBlocks: number;
  removedPageTypes: number;
  removedSlots: number;
  /** `cms_meta.content_version` after the publish. */
  contentVersion: number;
  /** False when every definition was already stored as-is. */
  changed: boolean;
}

interface MetaRow {
  contract_version: string;
  content_version: string;
}

interface DefinitionRow {
  name: string;
  removed_at: Date | null;
}

interface BlockTypeRow extends DefinitionRow {
  schema_hash: string;
}

interface PageTypeRow extends DefinitionRow {
  schema_hash: string;
}

interface SlotRow extends DefinitionRow {
  block_name: string;
  page: string;
  label: string | null;
  help: string | null;
}

interface SyncResult {
  changed: boolean;
  removed: number;
}

// SQLSTATEs that mean "the CMS's schema isn't what this build expects": the
// `cms_meta` relation is missing, or the column holding the version is. Both
// are setup problems, not mismatches — `assertContractVersion` has nothing to
// compare.
const NOT_SET_UP_CODES = new Set(["42P01", "42703"]);

const isNotSetUp = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errno?: unknown }).errno;
  return typeof code === "string" && NOT_SET_UP_CODES.has(code);
};

/**
 * Check the shape of a site's definitions before any database work.
 *
 * A config module is plain data from outside this package, so the loader
 * cannot rely on the types: a mis-wired `blocks: [slotDefinition]` should say
 * so clearly rather than fail later on a missing field.
 */
export const validateDefinitions = (definitions: SiteDefinitions): void => {
  checkKind(definitions.blocks, "block", "blocks");
  checkKind(definitions.pageTypes, "pageType", "pageTypes");
  checkKind(definitions.slots, "slot", "slots");
  assertUniqueNames(
    (definitions.blocks ?? []).map(({ name }) => name),
    "block type",
  );
  assertUniqueNames(
    (definitions.pageTypes ?? []).map(({ name }) => name),
    "page type",
  );
  assertUniqueNames(
    (definitions.slots ?? []).map(({ name }) => name),
    "slot",
  );
  assertBlocksResolve(definitions);
};

/**
 * Every block a slot or page type names has to be in the same publish.
 *
 * A slot filled by an undeclared block, or a page type allowing one, would
 * publish a row the CMS can't build a form from — a dangling reference that
 * only shows up when an editor opens the page. The config is all in one file,
 * so this is a mistake the publish can name before it writes anything.
 */
const assertBlocksResolve = (definitions: SiteDefinitions): void => {
  const blockNames = new Set(
    (definitions.blocks ?? []).map(({ name }) => name),
  );

  for (const definition of definitions.slots ?? []) {
    if (!blockNames.has(definition.blockName)) {
      throw new Error(
        `Slot "${definition.name}" is filled by block "${definition.blockName}", which this publish doesn't declare`,
      );
    }
  }

  for (const definition of definitions.pageTypes ?? []) {
    const referenced = [
      ...definition.allowedBlocks,
      ...definition.requiredBlocks,
    ];
    for (const block of referenced) {
      if (!blockNames.has(block.name)) {
        throw new Error(
          `Page type "${definition.name}" references block "${block.name}", which this publish doesn't declare`,
        );
      }
    }
  }
};

const checkKind = (
  definitions: readonly { kind?: string; name?: string }[] | undefined,
  expected: string,
  collection: string,
): void => {
  for (const definition of definitions ?? []) {
    if (definition.kind !== expected) {
      const named = definition.name ? ` ("${definition.name}")` : "";
      throw new Error(
        `Expected "${collection}" to contain only ${expected} definitions, but found "${definition.kind ?? "unknown"}"${named}`,
      );
    }
  }
};

const assertUniqueNames = (
  names: readonly string[],
  collection: string,
): void => {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Duplicate ${collection} "${name}" in this publish`);
    }
    seen.add(name);
  }
};

export const publish = async (
  sql: SQL,
  definitions: SiteDefinitions,
): Promise<PublishSummary> => {
  validateDefinitions(definitions);

  const blocks = definitions.blocks ?? [];
  const pageTypes = definitions.pageTypes ?? [];
  const slots = definitions.slots ?? [];

  return await sql.begin(async (tx) => {
    const meta = await readMeta(tx);
    assertContractVersion(meta?.contract_version);

    // One timestamp for every row this publish marks removed, so a deploy's
    // removals read as a single event.
    const removedAt = new Date();
    const blockResult = await syncBlockTypes(tx, blocks, removedAt);
    const pageTypeResult = await syncPageTypes(tx, pageTypes, removedAt);
    const slotResult = await syncSlots(tx, slots, removedAt);

    const changed =
      blockResult.changed || pageTypeResult.changed || slotResult.changed;
    const contentVersion = changed
      ? await bumpContentVersion(tx)
      : Number(meta?.content_version ?? 0);

    return {
      blocks: blocks.length,
      pageTypes: pageTypes.length,
      slots: slots.length,
      removedBlocks: blockResult.removed,
      removedPageTypes: pageTypeResult.removed,
      removedSlots: slotResult.removed,
      contentVersion,
      changed,
    };
  });
};

const readMeta = async (tx: SQL): Promise<MetaRow | undefined> => {
  try {
    // `FOR UPDATE` is what serialises concurrent publishes. Two deploys racing
    // would otherwise both read the pre-publish `content_version`, both decide
    // their definitions changed, and collide writing rows (or bump the version
    // twice for one change). The lock makes the second wait, re-read the row
    // after the first commits, and see the definitions already current.
    const rows = (await tx.unsafe(
      `SELECT contract_version, content_version FROM ${TABLES.meta} WHERE id = 1 FOR UPDATE`,
    )) as MetaRow[];
    return rows[0];
  } catch (error) {
    if (isNotSetUp(error)) throw new CmsNotSetUpError();
    throw error;
  }
};

const bumpContentVersion = async (tx: SQL): Promise<number> => {
  const rows = (await tx.unsafe(
    `UPDATE ${TABLES.meta}
     SET content_version = content_version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = 1
     RETURNING content_version`,
  )) as { content_version: string }[];
  return Number(rows[0]?.content_version ?? 0);
};

/**
 * Mark every stored row a deploy no longer declares as removed.
 *
 * A row already marked removed is left alone, so its original `removed_at` —
 * when the site dropped it — is never overwritten by a later publish.
 */
const markMissingRemoved = async (
  tx: SQL,
  table: string,
  existing: readonly DefinitionRow[],
  desiredNames: ReadonlySet<string>,
  removedAt: Date,
): Promise<number> => {
  let removed = 0;
  for (const row of existing) {
    if (desiredNames.has(row.name) || row.removed_at !== null) continue;
    await tx.unsafe(
      `UPDATE ${table}
       SET removed_at = $1, updated_at = CURRENT_TIMESTAMP
       WHERE name = $2`,
      [removedAt, row.name],
    );
    removed += 1;
  }
  return removed;
};

const syncBlockTypes = async (
  tx: SQL,
  blocks: readonly BlockDefinitionShape[],
  removedAt: Date,
): Promise<SyncResult> => {
  const desired = new Map<string, StoredSchema>();
  for (const definition of blocks) {
    desired.set(definition.name, blockStoredSchema(definition));
  }

  const existing = (await tx.unsafe(
    `SELECT name, schema_hash, removed_at FROM ${TABLES.blockTypes}`,
  )) as BlockTypeRow[];

  let changed = false;
  for (const [name, schema] of desired) {
    const current = existing.find((row) => row.name === name);
    if (current === undefined) {
      await tx.unsafe(
        `INSERT INTO ${TABLES.blockTypes} (name, json_schema, fields, schema_hash)
         VALUES ($1, $2, $3, $4)`,
        [name, schema.jsonSchema, schema.fields, schema.schemaHash],
      );
      changed = true;
    } else if (
      current.schema_hash !== schema.schemaHash ||
      current.removed_at !== null
    ) {
      // A re-added block clears `removed_at`; a changed one rewrites its schema.
      await tx.unsafe(
        `UPDATE ${TABLES.blockTypes}
         SET json_schema = $1, fields = $2, schema_hash = $3,
             removed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE name = $4`,
        [schema.jsonSchema, schema.fields, schema.schemaHash, name],
      );
      changed = true;
    }
  }

  const removed = await markMissingRemoved(
    tx,
    TABLES.blockTypes,
    existing,
    new Set(desired.keys()),
    removedAt,
  );
  return { changed: changed || removed > 0, removed };
};

const syncPageTypes = async (
  tx: SQL,
  pageTypes: readonly PageTypeDefinition[],
  removedAt: Date,
): Promise<SyncResult> => {
  const desired = new Map<string, StoredPageType>();
  for (const definition of pageTypes) {
    desired.set(definition.name, pageTypeStoredSchema(definition));
  }

  const existing = (await tx.unsafe(
    `SELECT name, schema_hash, removed_at FROM ${TABLES.pageTypes}`,
  )) as PageTypeRow[];

  let changed = false;
  for (const [name, schema] of desired) {
    const current = existing.find((row) => row.name === name);
    if (current === undefined) {
      await tx.unsafe(
        `INSERT INTO ${TABLES.pageTypes}
           (name, label, help, allowed_blocks, required_blocks, block_limits,
            json_schema, schema_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          name,
          schema.label ?? null,
          schema.help ?? null,
          schema.allowedBlocks,
          schema.requiredBlocks,
          schema.limits,
          schema.jsonSchema,
          schema.schemaHash,
        ],
      );
      changed = true;
    } else if (
      current.schema_hash !== schema.schemaHash ||
      current.removed_at !== null
    ) {
      await tx.unsafe(
        `UPDATE ${TABLES.pageTypes}
         SET label = $1, help = $2, allowed_blocks = $3, required_blocks = $4,
             block_limits = $5, json_schema = $6, schema_hash = $7,
             removed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE name = $8`,
        [
          schema.label ?? null,
          schema.help ?? null,
          schema.allowedBlocks,
          schema.requiredBlocks,
          schema.limits,
          schema.jsonSchema,
          schema.schemaHash,
          name,
        ],
      );
      changed = true;
    }
  }

  const removed = await markMissingRemoved(
    tx,
    TABLES.pageTypes,
    existing,
    new Set(desired.keys()),
    removedAt,
  );
  return { changed: changed || removed > 0, removed };
};

const slotMatches = (row: SlotRow, definition: SlotDefinition): boolean =>
  row.block_name === definition.blockName &&
  row.page === definition.page &&
  (row.label ?? null) === (definition.label ?? null) &&
  (row.help ?? null) === (definition.help ?? null);

const syncSlots = async (
  tx: SQL,
  slots: readonly SlotDefinition[],
  removedAt: Date,
): Promise<SyncResult> => {
  const existing = (await tx.unsafe(
    `SELECT name, block_name, page, label, help, removed_at FROM ${TABLES.slots}`,
  )) as SlotRow[];

  let changed = false;
  for (const definition of slots) {
    const current = existing.find((row) => row.name === definition.name);
    if (current === undefined) {
      await tx.unsafe(
        `INSERT INTO ${TABLES.slots} (name, block_name, page, label, help)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          definition.name,
          definition.blockName,
          definition.page,
          definition.label ?? null,
          definition.help ?? null,
        ],
      );
      changed = true;
    } else if (
      !slotMatches(current, definition) ||
      current.removed_at !== null
    ) {
      await tx.unsafe(
        `UPDATE ${TABLES.slots}
         SET block_name = $1, page = $2, label = $3, help = $4,
             removed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE name = $5`,
        [
          definition.blockName,
          definition.page,
          definition.label ?? null,
          definition.help ?? null,
          definition.name,
        ],
      );
      changed = true;
    }
  }

  const removed = await markMissingRemoved(
    tx,
    TABLES.slots,
    existing,
    new Set(slots.map(({ name }) => name)),
    removedAt,
  );
  return { changed: changed || removed > 0, removed };
};
