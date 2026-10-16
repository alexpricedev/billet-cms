/**
 * Compile a stored JSON Schema back into a Zod schema and validate against it.
 *
 * The CMS never imports a site's block definitions — the database is the
 * runtime contract — but the site publishes each block's content schema as JSON
 * Schema, so the CMS can rebuild the same Zod schema from that document and
 * validate an editor's input exactly the way the site will when it reads the
 * content back. `z.fromJSONSchema` is Zod 4's own reverse of the
 * `z.toJSONSchema` the publish step runs, which keeps the two directions from
 * drifting apart.
 *
 * `allowAdditionalFields` exists for Q4: a deploy can drop a field that saved
 * content still carries, and the CMS keeps that data rather than deleting it.
 * Turning the root object's `additionalProperties` back on lets the known
 * fields validate while the removed ones pass through — the write layer stores
 * them again, flags them in the form, and never silently drops them.
 */
import { z } from "zod";
import {
  MAX_RICH_TEXT_LIST_DEPTH,
  richTextListDepth,
} from "../fields/rich-text";

/** One reason a value failed its stored schema, with a path a form can point at. */
export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

export type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; issues: ValidationIssue[] };

type JsonSchema = Parameters<typeof z.fromJSONSchema>[0];

/**
 * Return `jsonSchema` with the root object allowed to carry unknown keys.
 *
 * Only the root is opened. Nested objects — an image value, a link, a rich text
 * node — keep their own `additionalProperties: false`, so a removed top-level
 * field survives while an unknown key inside a value is still refused.
 */
export const withAdditionalFields = (
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> => ({
  ...jsonSchema,
  additionalProperties: true,
});

/**
 * Build a validator from a stored JSON Schema.
 *
 * Throws when the stored document isn't a schema `fromJSONSchema` understands —
 * a publish that wrote something else is a bug the CMS should surface, not a
 * value it should wave through.
 */
export const compileStoredSchema = (
  jsonSchema: Record<string, unknown>,
): z.ZodType => z.fromJSONSchema(jsonSchema as JsonSchema);

export interface ValidateOptions {
  /** Allow unknown top-level keys, so removed fields survive a save (Q4). */
  allowAdditionalFields?: boolean;
}

/** Parse `value` against a stored JSON Schema, returning issues instead of throwing. */
export const validateContent = (
  jsonSchema: Record<string, unknown>,
  value: unknown,
  options: ValidateOptions = {},
): ValidationResult => {
  // The stored schema round-trips through `z.toJSONSchema`/`z.fromJSONSchema`,
  // which leaves rich text's `$defs` recursion unbounded: a document nested
  // deeply enough overflows the stack in the parse (a RangeError, not a
  // validation failure). The list-nesting bound is checked here, before the
  // recursive parse, on the raw value. Only list nodes count, so no legitimate
  // content is affected; a shallow document pays one cheap walk.
  if (richTextListDepth(value) > MAX_RICH_TEXT_LIST_DEPTH) {
    return {
      success: false,
      issues: [
        {
          path: [],
          message: `Rich text lists may nest at most ${MAX_RICH_TEXT_LIST_DEPTH} deep.`,
        },
      ],
    };
  }

  const source = options.allowAdditionalFields
    ? withAdditionalFields(jsonSchema)
    : jsonSchema;
  const parsed = compileStoredSchema(source).safeParse(value);

  if (parsed.success) return { success: true, data: parsed.data };

  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path as (string | number)[],
      message: issue.message,
    })),
  };
};
