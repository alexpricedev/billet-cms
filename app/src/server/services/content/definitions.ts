/**
 * Reading the definitions a site published on deploy.
 *
 * The CMS never imports site code: everything it needs about a block — the JSON
 * Schema content is validated against, and the field metadata tree a form is
 * built from — is in the row the site's publish wrote. These reads are the only
 * place that turns those rows into the shapes the rest of the CMS uses.
 */
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { db } from "../database";

export interface BlockTypeRecord {
  id: string;
  name: string;
  /**
   * The human name the editor sees, published from `block()`'s label. Empty
   * only for a row written by a site that predates labels; never shown in
   * place of the slug (Q2: there is no fallback).
   */
  label: string;
  jsonSchema: Record<string, unknown>;
  fields: FieldMetadata[];
  schemaHash: string;
  removedAt: Date | null;
}

export interface PageTypeRecord {
  id: string;
  name: string;
  label: string | null;
  help: string | null;
  allowedBlocks: string[];
  requiredBlocks: string[];
  limits: Record<string, unknown>;
  jsonSchema: Record<string, unknown>;
  removedAt: Date | null;
}

interface BlockTypeRow {
  id: string;
  name: string;
  label: string;
  json_schema: Record<string, unknown>;
  fields: FieldMetadata[];
  schema_hash: string;
  removed_at: Date | null;
}

interface PageTypeRow {
  id: string;
  name: string;
  label: string | null;
  help: string | null;
  allowed_blocks: string[];
  required_blocks: string[];
  block_limits: Record<string, unknown>;
  json_schema: Record<string, unknown>;
  removed_at: Date | null;
}

const toBlockType = (row: BlockTypeRow): BlockTypeRecord => ({
  id: row.id,
  name: row.name,
  label: row.label,
  jsonSchema: row.json_schema,
  fields: row.fields,
  schemaHash: row.schema_hash,
  removedAt: row.removed_at,
});

const toPageType = (row: PageTypeRow): PageTypeRecord => ({
  id: row.id,
  name: row.name,
  label: row.label,
  help: row.help,
  allowedBlocks: row.allowed_blocks,
  requiredBlocks: row.required_blocks,
  limits: row.block_limits,
  jsonSchema: row.json_schema,
  removedAt: row.removed_at,
});

export const listBlockTypes = async (): Promise<BlockTypeRecord[]> => {
  const rows = (await db`
    SELECT id, name, label, json_schema, fields, schema_hash, removed_at
    FROM cms_block_types
    ORDER BY name
  `) as BlockTypeRow[];
  return rows.map(toBlockType);
};

export const getBlockTypeByName = async (
  name: string,
): Promise<BlockTypeRecord | null> => {
  const rows = (await db`
    SELECT id, name, label, json_schema, fields, schema_hash, removed_at
    FROM cms_block_types
    WHERE name = ${name}
  `) as BlockTypeRow[];
  return rows.length > 0 ? toBlockType(rows[0]) : null;
};

export const listPageTypes = async (): Promise<PageTypeRecord[]> => {
  const rows = (await db`
    SELECT id, name, label, help, allowed_blocks, required_blocks,
           block_limits, json_schema, removed_at
    FROM cms_page_types
    ORDER BY name
  `) as PageTypeRow[];
  return rows.map(toPageType);
};

export const getPageTypeByName = async (
  name: string,
): Promise<PageTypeRecord | null> => {
  const rows = (await db`
    SELECT id, name, label, help, allowed_blocks, required_blocks,
           block_limits, json_schema, removed_at
    FROM cms_page_types
    WHERE name = ${name}
  `) as PageTypeRow[];
  return rows.length > 0 ? toPageType(rows[0]) : null;
};
