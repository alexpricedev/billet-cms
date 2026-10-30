import type {
  BlockDefinitionShape,
  PageTypeDefinition,
} from "@alexpricedev/billet-cms/fields";
import {
  blockStoredSchema,
  pageTypeStoredSchema,
} from "@alexpricedev/billet-cms/fields";
import type { SQL } from "bun";

/**
 * Publish a block type into `cms_block_types` the way a site's deploy would.
 *
 * The stored document comes from the plugin's own `blockStoredSchema`, so a
 * test's block and a real publish produce exactly the same row: the JSON Schema
 * the write layer validates against and the field metadata tree the form is
 * built from. `unsafe` mirrors the publish step — the JSONB documents are bound
 * as plain parameters, outside the tagged template the parameter guard checks.
 */
export const seedBlockType = async (
  db: SQL,
  definition: BlockDefinitionShape,
): Promise<string> => {
  const stored = blockStoredSchema(definition);
  const rows = (await db.unsafe(
    `INSERT INTO cms_block_types (name, label, json_schema, fields, schema_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      stored.name,
      stored.label,
      stored.jsonSchema,
      stored.fields,
      stored.schemaHash,
    ],
  )) as { id: string }[];
  return rows[0].id;
};

export interface SeedSlotInput {
  name: string;
  blockName: string;
  page: string;
  previewPath?: string;
  label?: string;
}

export const seedSlot = async (
  db: SQL,
  input: SeedSlotInput,
): Promise<string> => {
  const rows = (await db`
    INSERT INTO cms_slots (name, block_name, page, preview_path, label)
    VALUES (
      ${input.name},
      ${input.blockName},
      ${input.page},
      ${input.previewPath ?? "/"},
      ${input.label ?? null}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0].id;
};

/**
 * Publish a page type into `cms_page_types` the way a site's deploy would.
 *
 * Built from the plugin's `pageTypeStoredSchema`, so the allowed/required blocks,
 * the limits and the JSON Schema are exactly what a publish writes.
 */
export const seedPageType = async (
  db: SQL,
  definition: PageTypeDefinition,
): Promise<string> => {
  const stored = pageTypeStoredSchema(definition);
  const rows = (await db.unsafe(
    `INSERT INTO cms_page_types
       (name, label, help, allowed_blocks, required_blocks, block_limits,
        json_schema, schema_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      stored.name,
      stored.label ?? null,
      stored.help ?? null,
      stored.allowedBlocks,
      stored.requiredBlocks,
      stored.limits,
      stored.jsonSchema,
      stored.schemaHash,
    ],
  )) as { id: string }[];
  return rows[0].id;
};
