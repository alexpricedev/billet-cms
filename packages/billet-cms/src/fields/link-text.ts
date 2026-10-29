/**
 * The Button-text rule: a link the editor renders must carry visible words.
 *
 * `label` is optional in the stored schema, because links written before the
 * rule existed still have to validate. The rule is therefore an authoring
 * check, and it lives here rather than in the CMS so there is exactly one
 * definition: every write path asks the same question of a link.
 *
 * Every link owes its own Button text, wherever it sits — at the top level of a
 * block, inside a list item, or inside a group. A link with no destination is
 * not "filled in" — a page-mode link with no page chosen yet is what the editor
 * keeps so a failed save does not lose the mode — so it is never asked for text.
 */
import type { FieldMetadata } from "../contract";

/** The message every write path shows for a link that still owes its words. */
export const LINK_TEXT_REQUIRED = "Button text is required.";

/** One field-relative problem, in the shape the CMS's form points at. */
export interface LinkTextIssue {
  /** Dotted path to the missing label, e.g. `cta.label`. */
  path: string;
  message: string;
}

/**
 * True when a value is a link that names a destination, so its Button text is
 * needed. A page link with no page chosen yet, or a malformed value, is not.
 */
const hasLinkDestination = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "url") {
    return typeof record.url === "string" && record.url.trim() !== "";
  }
  if (record.type === "page") {
    return typeof record.pageId === "string" && record.pageId !== "";
  }
  return false;
};

/**
 * Button-text issues for the links the block's own metadata declares.
 *
 * Walks the field metadata tree rather than raw values on purpose. Content can
 * still carry a field a deploy removed (see `carryRemovedFields` in the CMS);
 * it has no control in the form, so an editor could never add the missing
 * button text and the whole block would be unpublishable. Following `list.of`
 * and `group.fields` is what reaches a link nested in either.
 */
const walk = (
  field: FieldMetadata,
  value: unknown,
  path: (string | number)[],
  issues: LinkTextIssue[],
): void => {
  if (field.kind === "link") {
    if (!hasLinkDestination(value)) return;
    const label = value.label;
    if (typeof label !== "string" || label.trim() === "") {
      issues.push({
        path: [...path, "label"].join("."),
        message: LINK_TEXT_REQUIRED,
      });
    }
    return;
  }

  if (field.kind === "list") {
    if (!field.of || !Array.isArray(value)) return;
    for (const [index, item] of value.entries()) {
      walk(field.of, item, [...path, index], issues);
    }
    return;
  }

  if (field.kind === "group") {
    if (!field.fields || typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const child of field.fields) {
      walk(child, record[child.name], [...path, child.name], issues);
    }
  }
};

/** Every Button-text issue in a block's stored content, keyed by dotted path. */
export const linkTextIssues = (
  fields: readonly FieldMetadata[],
  content: unknown,
): LinkTextIssue[] => {
  const issues: LinkTextIssue[] = [];
  if (typeof content !== "object" || content === null) return issues;
  const record = content as Record<string, unknown>;
  for (const field of fields) {
    walk(field, record[field.name], [field.name], issues);
  }
  return issues;
};
