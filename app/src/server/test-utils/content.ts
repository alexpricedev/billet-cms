import type { BlockDefinitionShape } from "@alexpricedev/billet-cms/fields";
import { blockStoredSchema } from "@alexpricedev/billet-cms/fields";
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
    `INSERT INTO cms_block_types (name, json_schema, fields, schema_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [stored.name, stored.jsonSchema, stored.fields, stored.schemaHash],
  )) as { id: string }[];
  return rows[0].id;
};

export interface SeedSlotInput {
  name: string;
  blockName: string;
  page: string;
  label?: string;
}

export const seedSlot = async (
  db: SQL,
  input: SeedSlotInput,
): Promise<string> => {
  const rows = (await db`
    INSERT INTO cms_slots (name, block_name, page, label)
    VALUES (
      ${input.name},
      ${input.blockName},
      ${input.page},
      ${input.label ?? null}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0].id;
};
