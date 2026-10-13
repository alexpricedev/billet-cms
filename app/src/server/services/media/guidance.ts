/**
 * Field guidance for images: the `minWidth` and `aspect` a site declares on an
 * `image()` field, enforced where content is saved.
 *
 * The trust boundary makes this a join the schema can't do. The JSON Schema
 * only says an image value is a UUID-referencing object; the picture behind
 * that id is a `cms_media` row, and whether it is big enough or the right shape
 * lives there. So the write layer, having validated the content, asks this
 * module to walk the field metadata tree and compare each reference against
 * the media it names.
 *
 * The guidance sits on the *field*, not the upload: the same picture can be a
 * hero on one block (1600px least) and a thumbnail on another, so an upload is
 * never refused for being small — a save that uses it where it doesn't fit is.
 * A reference whose media row is missing is left alone here; the site skips it
 * the same way, and flagging it belongs with the rest of the "removed content"
 * work, not a guidance rule.
 */
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { inList } from "../../utils/sql";
import type { FieldIssue } from "../content/drafts";
import { db } from "../database";

export interface MediaSize {
  width: number;
  height: number;
}

interface Reference {
  path: string;
  mediaId: string;
  guidance: { minWidth?: number; aspect?: string };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Walk a field's metadata tree, collecting every image reference it declares. */
const collectReferences = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  prefix: string,
  into: Reference[],
): void => {
  for (const field of fields) {
    const path = `${prefix}${field.name}`;

    if (field.kind === "image") {
      const value = asRecord(content[field.name]);
      const mediaId = value?.mediaId;
      if (typeof mediaId === "string" && mediaId !== "") {
        into.push({ path, mediaId, guidance: field.image ?? {} });
      }
      continue;
    }

    if (field.kind === "list" && field.of) {
      const items = content[field.name];
      if (!Array.isArray(items)) continue;
      items.forEach((item, index) => {
        const record = asRecord(item);
        if (record) {
          collectReferences(
            [field.of as FieldMetadata],
            record,
            `${path}.${index}.`,
            into,
          );
        }
      });
    }
  }
};

/** Every media id a block's content references, so the caller can load its sizes. */
export const referencedMediaIds = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
): string[] => {
  const references: Reference[] = [];
  collectReferences(fields, content, "", references);
  return [...new Set(references.map((reference) => reference.mediaId))];
};

/** The sizes of the media rows named, or an empty map when there are none. */
export const loadMediaSizes = async (
  ids: readonly string[],
): Promise<Map<string, MediaSize>> => {
  if (ids.length === 0) return new Map();

  const rows = (await db`
    SELECT id, width, height FROM cms_media WHERE id IN ${inList(ids)}
  `) as { id: string; width: number; height: number }[];

  return new Map(
    rows.map((row) => [row.id, { width: row.width, height: row.height }]),
  );
};

const ratio = (width: number, height: number): number => width / height;

/**
 * The guidance issues for one block's content.
 *
 * Called by both write paths after the content schema has passed, so a block
 * that doesn't even validate is reported once, by the schema, and never here.
 */
export const findImageGuidanceIssues = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  sizes: Map<string, MediaSize>,
): FieldIssue[] => {
  const references: Reference[] = [];
  collectReferences(fields, content, "", references);

  const issues: FieldIssue[] = [];
  for (const reference of references) {
    const size = sizes.get(reference.mediaId);
    if (!size) continue;

    const { minWidth, aspect } = reference.guidance;
    if (minWidth !== undefined && size.width < minWidth) {
      issues.push({
        path: `${reference.path}.mediaId`,
        message: `This image is ${size.width}px wide. Choose one at least ${minWidth}px wide.`,
      });
      continue;
    }

    if (aspect !== undefined) {
      const [rawWidth, rawHeight] = aspect.split(":");
      const wanted = ratio(Number(rawWidth), Number(rawHeight));
      const actual = ratio(size.width, size.height);
      // A two-percent tolerance: a "16:9" field accepts 1920x1080 and a photo
      // cropped to 1.778 either way, and refuses a genuinely different shape.
      if (Math.abs(actual - wanted) / wanted > 0.02) {
        issues.push({
          path: `${reference.path}.mediaId`,
          message: `This image is ${size.width}×${size.height}. Choose a ${aspect} image.`,
        });
      }
    }
  }

  return issues;
};

/**
 * Enforce a block's image guidance against the media its content references.
 *
 * Loads the sizes of only the media the content names, so a block with no image
 * fields costs nothing. Called by both write paths after the schema check.
 */
export const checkImageGuidance = async (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
): Promise<FieldIssue[]> => {
  const ids = referencedMediaIds(fields, content);
  if (ids.length === 0) return [];
  const sizes = await loadMediaSizes(ids);
  return findImageGuidanceIssues(fields, content, sizes);
};
