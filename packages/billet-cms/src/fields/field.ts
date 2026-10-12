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
import type { FieldKind, FieldMetadata, ImageGuidance } from "../contract";
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
 * The value a field produces, given its options.
 *
 * A field is required unless `required: false` says otherwise, so the common
 * declaration is `Field<T>` and only an explicit `required: false` widens it to
 * `T | undefined`. This is what a block's render function sees: a required
 * field is present, and the site is no longer asked to handle `undefined` for
 * one it declared as required.
 */
export type FieldValue<T, O extends FieldOptions> = O extends {
  required: false;
}
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
export const text = <O extends TextOptions = TextOptions>(
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
export const richText = <O extends FieldOptions = FieldOptions>(
  options: O = {} as O,
): Field<FieldValue<RichTextDocument, O>> => ({
  kind: "richText",
  required: options.required !== false,
  schema: optional(richTextSchema, options),
  metadata: (name) => baseMetadata(name, "richText", options),
});

const imageValue = z.strictObject({
  mediaId: z.uuid(),
  alt: z.string().optional(),
});

/** A reference to an image in the media library. */
export const image = <O extends ImageOptions = ImageOptions>(
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
export const link = <O extends FieldOptions = FieldOptions>(
  options: O = {} as O,
): Field<FieldValue<LinkValue, O>> => ({
  kind: "link",
  required: options.required !== false,
  schema: optional(linkValue, options),
  metadata: (name) => baseMetadata(name, "link", options),
});

/** A repeatable list of another field. */
export const list = <T, O extends ListOptions = ListOptions>(
  of: Field<T>,
  options: O = {} as O,
): Field<FieldValue<T[], O>> => {
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

  return {
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
};
