/**
 * The Billet field vocabulary.
 *
 * A site defines its blocks with these constructors on top of Zod 4; publishing
 * flattens the result to JSON Schema plus the metadata tree in `../contract`.
 * The constructors own two things at once, which is why they are the only way
 * to declare a field: the Zod schema that validates stored content, and the
 * metadata the CMS turns into a form control.
 */
import { z } from "zod";
import {
  type FieldKind,
  type FieldMetadata,
  type ImageGuidance,
  MAX_ALT_LENGTH,
} from "../contract";
import { assertMinMax, assertNonNegativeInteger } from "./options";
import { type RichTextDocument, richTextSchema } from "./rich-text";
import { URL_PATTERN, URL_PATTERN_MESSAGE } from "./url";

export interface FieldOptions {
  label?: string;
  help?: string;
  /** Required by default; `false` makes the field optional in stored content. */
  required?: boolean;
}

/**
 * The options of a call that passes none.
 *
 * Deliberately not `FieldOptions`: that carries `required?: boolean`, which
 * `FieldValue` has to read as "might be false" and so widens to
 * `T | undefined`. An empty object type carries no `required` key, so an
 * optionless `text()` stays required while a variable typed `FieldOptions`
 * widens. `Record<never, never>` is the empty object type without the banned
 * `{}`.
 */
type DefaultOptions = Record<never, never>;

/**
 * The value a field produces, given its options.
 *
 * A field is required unless `required: false` says otherwise, so the common
 * declaration is `Field<T>` and only an explicit `required: false` widens it to
 * `T | undefined`. This is what a block's render function sees: a required
 * field is present, and the site is no longer asked to handle `undefined` for
 * one it declared as required.
 *
 * The check is sound for a non-literal flag, which is why it does not simply
 * test `O extends { required: false }`. When `required` is a `boolean` in
 * option type — a variable of type `FieldOptions`, not an inline literal — the
 * compiler cannot know which way it went, so the value could be absent and the
 * only honest answer is `T | undefined`. Only an options type that does not
 * carry a `required` key at all (the default an optionless call uses, or one
 * that sets other options) is treated as present.
 */
export type FieldValue<T, O extends FieldOptions> = O extends {
  required: true;
}
  ? T
  : "required" extends keyof O
    ? T | undefined
    : T;

/**
 * One declared field.
 *
 * `T` is only for inference at the call site — `block()` reads it to type the
 * render function's content. Nothing at runtime depends on it.
 */
export interface Field<T = unknown> {
  readonly kind: FieldKind;
  /** Whether the field must be present in stored content. */
  readonly required: boolean;
  readonly schema: z.ZodType<T>;
  /** Build the metadata the CMS renders, given the field's name. */
  metadata(name: string): FieldMetadata;
}

export interface TextOptions extends FieldOptions {
  /** The most characters the editor may type. */
  max?: number;
}

export interface ImageOptions extends FieldOptions {
  /** The smallest source width the CMS accepts, in pixels. */
  minWidth?: number;
  /** The preferred aspect ratio, e.g. `"16:9"`. */
  aspect?: string;
}

export interface ListOptions extends FieldOptions {
  /** The fewest entries allowed. */
  min?: number;
  /** The most entries allowed. */
  max?: number;
}

/** A reference to a `cms_media` row, with an optional per-use alt override. */
export interface ImageValue {
  mediaId: string;
  alt?: string;
}

/** A link to a CMS page (by id, so it survives URL changes) or a free URL. */
export type LinkValue =
  | { type: "page"; pageId: string; label?: string; newTab?: boolean }
  | { type: "url"; url: string; label?: string; newTab?: boolean };

/** The shape an image field's `aspect` guidance must take, e.g. `"16:9"`. */
export const ASPECT_PATTERN = /^\d+:\d+$/;

const baseMetadata = (
  name: string,
  kind: FieldKind,
  options: FieldOptions,
): FieldMetadata => {
  const metadata: FieldMetadata = {
    name,
    kind,
    required: options.required !== false,
  };
  if (options.label !== undefined) metadata.label = options.label;
  if (options.help !== undefined) metadata.help = options.help;
  return metadata;
};

/**
 * Apply `required: false` to a field's schema.
 *
 * The cast is one-directional and safe: a schema that accepts `T` accepts a
 * `T`, so widening the declared output to `T | undefined` only records what the
 * optional wrapper already does. A required field keeps the plain schema, so
 * `FieldValue` narrowing to `T` matches what is actually validated.
 */
const optional = <T, O extends FieldOptions>(
  schema: z.ZodType<T>,
  options: O,
): z.ZodType<FieldValue<T, O>> =>
  (options.required === false ? schema.optional() : schema) as z.ZodType<
    FieldValue<T, O>
  >;

/** A short, single-line string. */
export const text = <O extends TextOptions = DefaultOptions>(
  options: O = {} as O,
): Field<FieldValue<string, O>> => {
  if (options.max !== undefined)
    assertNonNegativeInteger(options.max, "text max");

  const schema =
    options.max === undefined ? z.string() : z.string().max(options.max);

  return {
    kind: "text",
    required: options.required !== false,
    schema: optional(schema, options),
    metadata: (name) => {
      const metadata = baseMetadata(name, "text", options);
      if (options.max !== undefined) metadata.max = options.max;
      return metadata;
    },
  };
};

/** A rich text document, in the restricted structured-JSON format (Q1). */
export const richText = <O extends FieldOptions = DefaultOptions>(
  options: O = {} as O,
): Field<FieldValue<RichTextDocument, O>> => ({
  kind: "richText",
  required: options.required !== false,
  schema: optional(richTextSchema, options),
  metadata: (name) => baseMetadata(name, "richText", options),
});

const imageValue = z.strictObject({
  mediaId: z.uuid(),
  // The per-use override is capped like the upload's own alt: it becomes the
  // rendered `alt` attribute everywhere the image is used, so an unbounded
  // value is unbounded output on every page that reuses the picture. The limit
  // is shared from the contract, so the site's schema and the CMS's stored
  // contract can't drift.
  alt: z.string().max(MAX_ALT_LENGTH).optional(),
});

/** A reference to an image in the media library. */
export const image = <O extends ImageOptions = DefaultOptions>(
  options: O = {} as O,
): Field<FieldValue<ImageValue, O>> => {
  if (options.minWidth !== undefined) {
    assertNonNegativeInteger(options.minWidth, "image minWidth");
  }
  if (options.aspect !== undefined && !ASPECT_PATTERN.test(options.aspect)) {
    throw new Error(
      `image aspect must look like "16:9", got "${options.aspect}"`,
    );
  }

  const guidance: ImageGuidance = {};
  if (options.minWidth !== undefined) guidance.minWidth = options.minWidth;
  if (options.aspect !== undefined) guidance.aspect = options.aspect;
  const hasGuidance =
    options.minWidth !== undefined || options.aspect !== undefined;

  return {
    kind: "image",
    required: options.required !== false,
    schema: optional(imageValue, options),
    metadata: (name) => {
      const metadata = baseMetadata(name, "image", options);
      if (hasGuidance) metadata.image = guidance;
      return metadata;
    },
  };
};

const pageLink = z.strictObject({
  type: z.literal("page"),
  pageId: z.uuid(),
  label: z.string().optional(),
  newTab: z.boolean().optional(),
});

const urlLink = z.strictObject({
  type: z.literal("url"),
  url: z.string().regex(URL_PATTERN, URL_PATTERN_MESSAGE),
  label: z.string().optional(),
  newTab: z.boolean().optional(),
});

const linkValue = z.discriminatedUnion("type", [pageLink, urlLink]);

/** A link to a CMS page or a free URL. */
export const link = <O extends FieldOptions = DefaultOptions>(
  options: O = {} as O,
): Field<FieldValue<LinkValue, O>> => ({
  kind: "link",
  required: options.required !== false,
  schema: optional(linkValue, options),
  metadata: (name) => baseMetadata(name, "link", options),
});

/**
 * How deeply `list()` fields may nest.
 *
 * The editor builds one control per nested list by recursing the metadata tree,
 * and the client walks the same tree back into the document, so an
 * arbitrarily deep tree is a stack-depth problem at both ends. Eight is far past
 * anything a real block declares (a list of lists of lists already is), so the
 * bound only ever fires on a mistake.
 */
export const MAX_LIST_DEPTH = 8;

/**
 * The nesting depth of each field, so `list()` can bound the tree.
 *
 * A field object is the only handle `list()` has on the field it repeats, and
 * the depth is not part of the public shape, so it is tracked here by identity
 * rather than added to `Field`.
 */
const listDepths = new WeakMap<Field, number>();

/** A repeatable list of another field. */
export const list = <T, O extends ListOptions = DefaultOptions>(
  of: Field<T>,
  options: O = {} as O,
): Field<FieldValue<T[], O>> => {
  const depth = (listDepths.get(of) ?? 0) + 1;
  if (depth > MAX_LIST_DEPTH) {
    throw new Error(
      `list() fields may nest at most ${MAX_LIST_DEPTH} deep; this one is ${depth}. Flatten the field or split it into its own block.`,
    );
  }
  if (!of.required) {
    // A list item is never absent: `required: false` would make every entry
    // `T | undefined`, so an empty slot in a list has to be the site's problem
    // to represent, not a hole the CMS writes.
    throw new Error(
      "list() items must be required; declare the item field without `required: false`",
    );
  }
  if (options.min !== undefined)
    assertNonNegativeInteger(options.min, "list min");
  if (options.max !== undefined)
    assertNonNegativeInteger(options.max, "list max");
  assertMinMax(options.min, options.max, "list");

  let schema = z.array(of.schema);
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);

  const field: Field<FieldValue<T[], O>> = {
    kind: "list",
    required: options.required !== false,
    schema: optional(schema, options),
    metadata: (name) => {
      const metadata = baseMetadata(name, "list", options);
      if (options.min !== undefined) metadata.min = options.min;
      if (options.max !== undefined) metadata.max = options.max;
      metadata.of = of.metadata("item");
      return metadata;
    },
  };

  listDepths.set(field, depth);
  return field;
};
