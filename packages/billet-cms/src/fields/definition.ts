/**
 * Blocks, slots and page types — the things a site declares in code and
 * publishes on deploy.
 *
 * `render` is carried here so a site's templates can use the same definition
 * the publish step sees, but it is never serialised: the CMS builds its forms
 * from the JSON Schema and metadata instead of importing site code.
 */
import { z } from "zod";
import {
  type BlockLimit,
  hashJson,
  STORED_SCHEMA_FORMAT,
  STORED_SCHEMA_FORMAT_VERSION,
  type StoredPageType,
  type StoredSchema,
} from "../contract";
import type { Field } from "./field";
import { assertName, SLOT_NAME_PATTERN } from "./name";
import { assertMinMax, assertNonNegativeInteger } from "./options";

export type BlockFields = Record<string, Field>;

/** The validated content a block's render function receives. */
export type BlockContent<F extends BlockFields> = {
  [K in keyof F]: z.infer<F[K]["schema"]>;
};

export type BlockRender<F extends BlockFields> = (
  content: BlockContent<F>,
) => unknown;

export interface BlockDefinition<F extends BlockFields = BlockFields>
  extends BlockDefinitionShape {
  readonly fields: F;
  /** The site's render function. Never published. */
  readonly render: BlockRender<F>;
}

/**
 * A block definition with its render function erased.
 *
 * The publish step and `slot()`/`pageType()` never call `render`, and a
 * `BlockDefinition<F>` for a specific `F` is not assignable to
 * `BlockDefinition<BlockFields>` — `render` is contravariant in its content —
 * so the shape is what those APIs take instead.
 */
export interface BlockDefinitionShape {
  readonly kind: "block";
  /** The block type name, unique within its kind. */
  readonly name: string;
  readonly fields: BlockFields;
}

/** Define a block type. */
export const block = <F extends BlockFields>(
  name: string,
  fields: F,
  render: BlockRender<F>,
): BlockDefinition<F> => {
  assertName(name, "block");
  for (const fieldName of Object.keys(fields)) {
    assertName(fieldName, "field", { context: `in block "${name}"` });
  }
  if (Object.hasOwn(fields, "type")) {
    // A page's content is an array of blocks told apart by a `type`
    // discriminator (see `blockVariantSchema`). A field named `type` would
    // overwrite it and make the stored content ambiguous, so it is rejected
    // where the mistake is, not when the page fails to validate.
    throw new Error(
      `Block "${name}" declares a field named "type", which collides with the block's page-content discriminator`,
    );
  }
  return { kind: "block", name, fields, render };
};

export interface SlotOptions {
  label?: string;
  help?: string;
  /**
   * The page the slot belongs to, used by the CMS to group slots. Defaults to
   * the first segment of the slot name: `slot("home.hero", hero)` is on `home`.
   */
  page?: string;
}

export interface SlotDefinition {
  readonly kind: "slot";
  /** The slot name as declared in the template, e.g. `"home.hero"`. */
  readonly name: string;
  /** The block type that fills the slot. */
  readonly blockName: string;
  /** The page the slot is listed under in the CMS. */
  readonly page: string;
  readonly label?: string;
  readonly help?: string;
}

/** Define a named slot in a template, filled by a block type. */
export const slot = (
  name: string,
  definition: BlockDefinitionShape,
  options: SlotOptions = {},
): SlotDefinition => {
  assertName(name, "slot", { pattern: SLOT_NAME_PATTERN });

  return {
    kind: "slot",
    name,
    blockName: definition.name,
    page: options.page ?? name.split(".")[0],
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.help !== undefined ? { help: options.help } : {}),
  };
};

export interface PageTypeOptions {
  label?: string;
  help?: string;
  /** The block types a page of this type may contain. */
  allowedBlocks?: readonly BlockDefinitionShape[];
  /** The block types a page of this type must contain. */
  requiredBlocks?: readonly BlockDefinitionShape[];
  /** Per-block limits, such as `{ hero: { max: 1, position: "top" } }`. */
  limits?: Record<string, BlockLimit>;
}

export interface PageTypeDefinition {
  readonly kind: "pageType";
  readonly name: string;
  readonly label?: string;
  readonly help?: string;
  readonly allowedBlocks: readonly BlockDefinitionShape[];
  readonly requiredBlocks: readonly BlockDefinitionShape[];
  readonly limits: Record<string, BlockLimit>;
}

/**
 * Define a page type.
 *
 * Required blocks and limit keys must name an allowed block. This is a config
 * mistake that would otherwise surface as an editor staring at a form the page
 * type says can't be built, so it throws here, at the declaration.
 */
export const pageType = (
  name: string,
  options: PageTypeOptions = {},
): PageTypeDefinition => {
  assertName(name, "page type");
  const allowedBlocks = options.allowedBlocks ?? [];
  const requiredBlocks = options.requiredBlocks ?? [];
  const limits = options.limits ?? {};
  const allowedNames = new Set(
    allowedBlocks.map((definition) => definition.name),
  );

  for (const definition of requiredBlocks) {
    if (!allowedNames.has(definition.name)) {
      throw new Error(
        `Page type "${name}" requires block "${definition.name}", which is not in allowedBlocks`,
      );
    }
  }
  for (const [blockName, limit] of Object.entries(limits)) {
    if (!allowedNames.has(blockName)) {
      throw new Error(
        `Page type "${name}" sets limits for "${blockName}", which is not in allowedBlocks`,
      );
    }
    const label = `Page type "${name}" limit for "${blockName}"`;
    if (limit.min !== undefined)
      assertNonNegativeInteger(limit.min, `${label} min`);
    if (limit.max !== undefined)
      assertNonNegativeInteger(limit.max, `${label} max`);
    assertMinMax(limit.min, limit.max, label);
  }

  return {
    kind: "pageType",
    name,
    allowedBlocks,
    requiredBlocks,
    limits,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.help !== undefined ? { help: options.help } : {}),
  };
};

/** The Zod shape of a block's fields, keyed by field name. */
const fieldShape = (fields: BlockFields): Record<string, z.ZodType> =>
  Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.schema]),
  );

/** The Zod schema for a block's stored content: just its fields. */
export const blockContentSchema = (
  definition: BlockDefinitionShape,
): z.ZodType => z.strictObject(fieldShape(definition.fields));

/**
 * The same schema for a read: unknown keys are stripped rather than refused.
 *
 * `blockContentSchema` is strict because the publish step turns it into the
 * stored JSON Schema, where `additionalProperties: false` is the contract the
 * CMS validates against. On the read side that strictness is wrong: Q4 says a
 * field a deploy has dropped stays in the stored content and must not break a
 * read, so the site's own check strips the removed key instead of rejecting the
 * whole block. A field whose type changed still fails, which is the mismatch
 * this check exists to catch.
 */
export const blockContentReadSchema = (
  definition: BlockDefinitionShape,
): z.ZodType => z.object(fieldShape(definition.fields));

/**
 * A block as it appears inside a page's content array: its fields plus a `type`
 * discriminator, so several block types can share one array and be told apart.
 */
const blockVariantSchema = (definition: BlockDefinitionShape): z.ZodType =>
  z.strictObject({
    type: z.literal(definition.name),
    ...fieldShape(definition.fields),
  });

/** The Zod schema for a page's content: an array of the allowed blocks. */
export const pageTypeContentSchema = (
  definition: PageTypeDefinition,
): z.ZodType => {
  const variants = definition.allowedBlocks.map(blockVariantSchema);
  if (variants.length === 0) return z.array(z.never());
  const items =
    variants.length === 1
      ? variants[0]
      : z.union([variants[0], ...variants.slice(1)]);
  return z.array(items);
};

/** Flatten a block type to the document stored in `cms_block_types`. */
export const blockStoredSchema = (
  definition: BlockDefinitionShape,
): StoredSchema => {
  const jsonSchema = z.toJSONSchema(blockContentSchema(definition)) as Record<
    string,
    unknown
  >;
  const fields = Object.entries(definition.fields).map(([name, field]) =>
    field.metadata(name),
  );

  return {
    format: STORED_SCHEMA_FORMAT,
    version: STORED_SCHEMA_FORMAT_VERSION,
    name: definition.name,
    jsonSchema,
    fields,
    schemaHash: hashJson({ jsonSchema, fields }),
  };
};

/** Flatten a page type to the document stored in `cms_page_types`. */
export const pageTypeStoredSchema = (
  definition: PageTypeDefinition,
): StoredPageType => {
  const jsonSchema = z.toJSONSchema(
    pageTypeContentSchema(definition),
  ) as Record<string, unknown>;
  const allowedBlocks = definition.allowedBlocks.map(({ name }) => name);
  const requiredBlocks = definition.requiredBlocks.map(({ name }) => name);
  const { limits } = definition;

  return {
    format: STORED_SCHEMA_FORMAT,
    version: STORED_SCHEMA_FORMAT_VERSION,
    name: definition.name,
    allowedBlocks,
    requiredBlocks,
    limits,
    jsonSchema,
    schemaHash: hashJson({
      jsonSchema,
      allowedBlocks,
      requiredBlocks,
      limits,
      label: definition.label,
      help: definition.help,
    }),
    ...(definition.label !== undefined ? { label: definition.label } : {}),
    ...(definition.help !== undefined ? { help: definition.help } : {}),
  };
};
