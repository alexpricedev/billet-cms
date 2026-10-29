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
 * A reference whose media row is missing is left alone on a save: the site skips
 * it the same way, and refusing the save would lose the editor's draft. A
 * publish refuses it instead — see `findDeletedImageIssues` — because a live
 * page must not point at a file that is gone.
 *
 * The two guidelines are not equally hard. `aspect` is a shape the site's layout
 * relies on, so a save that breaks it is refused. `minWidth` is a fidelity
 * guideline: a narrow hero looks soft but still renders, and refusing the save
 * only moved the argument to the moment the editor picked the picture (#53 f9,
 * #57 f5, #60 f43, #67 f6). So a short width is a *warning* — returned beside
 * the refusing issues so the save goes ahead and the editor is told.
 */
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { narrowImageWarning } from "@shared/image-guidance";
import type { SQL } from "bun";
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

/**
 * Collect the image references in one field's value, at any depth.
 *
 * Takes the value rather than the record holding it, because a list's items
 * are bare values: an item has no key to look itself up by. The previous
 * version recursed with the item wrapped in a record and the item metadata's
 * own name (`"item"`) as the key, so it looked for `item.item` and found
 * nothing — `image()` inside `list()` was collected as zero references, which
 * silently turned off `minWidth`/`aspect` enforcement on a save and the
 * deleted-image refusal on a publish for every image in a list. The delete
 * protection itself was never affected: that walks stored values through
 * `collectMediaIds`, not this tree.
 */
const collectFrom = (
  field: FieldMetadata,
  value: unknown,
  path: string,
  into: Reference[],
): void => {
  if (field.kind === "image") {
    const mediaId = asRecord(value)?.mediaId;
    if (typeof mediaId === "string" && mediaId !== "") {
      into.push({ path, mediaId, guidance: field.image ?? {} });
    }
    return;
  }

  if (field.kind === "list") {
    const item = field.of;
    if (!item || !Array.isArray(value)) return;
    value.forEach((entry, index) => {
      collectFrom(item, entry, `${path}.${index}`, into);
    });
    return;
  }

  if (field.kind === "group") {
    const record = asRecord(value);
    if (!record) return;
    for (const child of field.fields ?? []) {
      collectFrom(child, record[child.name], `${path}.${child.name}`, into);
    }
  }
};

/** Walk a field's metadata tree, collecting every image reference it declares. */
const collectReferences = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  prefix: string,
  into: Reference[],
): void => {
  for (const field of fields) {
    collectFrom(field, content[field.name], `${prefix}${field.name}`, into);
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

/**
 * The sizes of the media rows named, or an empty map when there are none.
 *
 * `sql` is the transaction when the caller already holds one — a publish locks
 * the rows and reads their sizes through the same connection rather than a
 * second one.
 */
export const loadMediaSizes = async (
  ids: readonly string[],
  sql: SQL = db,
): Promise<Map<string, MediaSize>> => {
  if (ids.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, width, height FROM cms_media WHERE id IN ${inList(ids)}
  `) as { id: string; width: number; height: number }[];

  return new Map(
    rows.map((row) => [row.id, { width: row.width, height: row.height }]),
  );
};

/**
 * Every media id a stored content value names, at any depth.
 *
 * Used by the publish paths to take a `FOR SHARE` lock on the images a revision
 * is about to make live, so a delete running at the same time serialises against
 * it (`deleteMedia` in `./media` takes the same rows `FOR UPDATE`).
 */
export const collectMediaIds = (value: unknown): string[] => {
  const ids = new Set<string>();
  const walk = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    if (typeof record.mediaId === "string" && record.mediaId !== "") {
      ids.add(record.mediaId);
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(value);
  return [...ids];
};

/**
 * Lock the media rows a revision references, for the length of a transaction.
 *
 * `deleteMedia` takes the same rows `FOR UPDATE`; a publish holding these shared
 * locks can't have an image deleted out from under the revision it is putting
 * live. The ids that were found are returned so the caller can check, without
 * another query, which references have no row left (Q1): a draft-only delete
 * makes the publish wait, then find the row gone and refuse.
 */
export const lockReferencedMedia = async (
  sql: SQL,
  content: unknown,
): Promise<Set<string>> => {
  const ids = collectMediaIds(content);
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT id FROM cms_media
    WHERE id IN ${inList(ids)}
    ORDER BY id
    FOR SHARE
  `) as { id: string }[];
  return new Set(rows.map((row) => row.id));
};

const ratio = (width: number, height: number): number => width / height;

/** The two kinds of guidance finding: what refuses a save, and what only warns. */
export interface ImageGuidance {
  issues: FieldIssue[];
  warnings: FieldIssue[];
}

/**
 * The guidance findings for one block's content.
 *
 * Called by both write paths after the content schema has passed, so a block
 * that doesn't even validate is reported once, by the schema, and never here.
 * An `aspect` mismatch is an issue the caller refuses the save on; a `minWidth`
 * shortfall is a warning the caller saves through, and shows. The two are split
 * here rather than by the callers so every write path treats them the same.
 */
export const findImageGuidance = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  sizes: Map<string, MediaSize>,
): ImageGuidance => {
  const references: Reference[] = [];
  collectReferences(fields, content, "", references);

  const issues: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  for (const reference of references) {
    const size = sizes.get(reference.mediaId);
    if (!size) continue;

    const { minWidth, aspect } = reference.guidance;
    if (minWidth !== undefined && size.width < minWidth) {
      warnings.push({
        path: `${reference.path}.mediaId`,
        message: narrowImageWarning(size.width, minWidth),
      });
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

  return { issues, warnings };
};

/**
 * The refusing issues alone, for a caller that has no use for the warnings.
 *
 * Kept as its own name because "does this block pass" reads better at a call
 * site than destructuring a result and ignoring half of it.
 */
export const findImageGuidanceIssues = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  sizes: Map<string, MediaSize>,
): FieldIssue[] => findImageGuidance(fields, content, sizes).issues;

/** The message a publish shows for a reference whose `cms_media` row is gone. */
export const DELETED_IMAGE_MESSAGE = "This image was deleted. Choose another.";

/**
 * The references in one block's content whose media row no longer exists.
 *
 * A save tolerates a deleted reference — `findImageGuidanceIssues` skips a
 * missing row — so an editor never loses a draft because an image went.
 * Publishing refuses it instead (Q1): putting the revision live would hand the
 * site content pointing at a file that isn't there. `existing` is the media the
 * publish path has already locked and returned, so this is a map lookup per
 * reference, not a query per block.
 */
export const findDeletedImageIssues = (
  fields: FieldMetadata[],
  content: Record<string, unknown>,
  existing: ReadonlySet<string>,
): FieldIssue[] => {
  const references: Reference[] = [];
  collectReferences(fields, content, "", references);

  const issues: FieldIssue[] = [];
  for (const reference of references) {
    if (!existing.has(reference.mediaId)) {
      issues.push({
        path: `${reference.path}.mediaId`,
        message: DELETED_IMAGE_MESSAGE,
      });
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
): Promise<ImageGuidance> => {
  const ids = referencedMediaIds(fields, content);
  if (ids.length === 0) return { issues: [], warnings: [] };
  const sizes = await loadMediaSizes(ids);
  return findImageGuidance(fields, content, sizes);
};
