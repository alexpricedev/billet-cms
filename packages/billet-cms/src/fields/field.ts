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
import { type RichTextDocument, richTextSchema } from "./rich-text";

export interface FieldOptions {
  label?: string;
  help?: string;
  /** Required by default; `false` makes the field optional in stored content. */
  required?: boolean;
}

/**
 * One declared field.
 *
 * `T` is only for inference at the call site — `block()` reads it to type the
 * render function's content. Nothing at runtime depends on it.
 */
export interface Field<T = unknown> {
  readonly kind: FieldKind;
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
 * optional wrapper already does.
 */
const optional = <T>(
  schema: z.ZodType<T>,
  options: FieldOptions,
): z.ZodType<T | undefined> =>
  options.required === false
    ? (schema.optional() as z.ZodType<T | undefined>)
    : (schema as z.ZodType<T | undefined>);

/** A short, single-line string. */
export const text = (options: TextOptions = {}): Field<string | undefined> => {
  const schema =
    options.max === undefined ? z.string() : z.string().max(options.max);

  return {
    kind: "text",
    schema: optional(schema, options),
    metadata: (name) => {
      const metadata = baseMetadata(name, "text", options);
      if (options.max !== undefined) metadata.max = options.max;
      return metadata;
    },
  };
};

/** A rich text document, in the restricted structured-JSON format (Q1). */
export const richText = (
  options: FieldOptions = {},
): Field<RichTextDocument | undefined> => ({
  kind: "richText",
  schema: optional(richTextSchema, options),
  metadata: (name) => baseMetadata(name, "richText", options),
});

const imageValue = z.object({
  mediaId: z.uuid(),
  alt: z.string().optional(),
});

/** A reference to an image in the media library. */
export const image = (
  options: ImageOptions = {},
): Field<ImageValue | undefined> => {
  const guidance: ImageGuidance = {};
  if (options.minWidth !== undefined) guidance.minWidth = options.minWidth;
  if (options.aspect !== undefined) guidance.aspect = options.aspect;
  const hasGuidance =
    options.minWidth !== undefined || options.aspect !== undefined;

  return {
    kind: "image",
    schema: optional(imageValue, options),
    metadata: (name) => {
      const metadata = baseMetadata(name, "image", options);
      if (hasGuidance) metadata.image = guidance;
      return metadata;
    },
  };
};

const pageLink = z.object({
  type: z.literal("page"),
  pageId: z.uuid(),
  label: z.string().optional(),
  newTab: z.boolean().optional(),
});

const urlLink = z.object({
  type: z.literal("url"),
  url: z.string().min(1),
  label: z.string().optional(),
  newTab: z.boolean().optional(),
});

const linkValue = z.discriminatedUnion("type", [pageLink, urlLink]);

/** A link to a CMS page or a free URL. */
export const link = (
  options: FieldOptions = {},
): Field<LinkValue | undefined> => ({
  kind: "link",
  schema: optional(linkValue, options),
  metadata: (name) => baseMetadata(name, "link", options),
});

/** A repeatable list of another field. */
export const list = <T>(
  of: Field<T>,
  options: ListOptions = {},
): Field<T[] | undefined> => {
  let schema = z.array(of.schema);
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);

  return {
    kind: "list",
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
