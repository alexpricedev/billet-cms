/**
 * A one-line excerpt of a revision, for the history list.
 *
 * Two revisions saved on the same day looked identical: the row showed a date,
 * an author and badges, and the Restore button only named the day. The excerpt
 * gives each row something of its own to read — the page's title and the first
 * block's first text field, or a slot's first text field — so a glance at the
 * list says what changed between them. It is a display summary, never stored: it
 * is derived from the revision content the history query already reads.
 *
 * The field walk follows a group's `fields` (a group is a nested object) but
 * stops at a list: a list is repeated copy rather than a summary, so the first
 * entry would represent the block no better than the next. Images and links are
 * skipped for the same reason — an id or a URL is not something an editor reads
 * as "what this version says".
 */
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";

/** How long an excerpt runs before it is cut. */
export const EXCERPT_LENGTH = 80;

/** The separator between a page's title and its first block's text. */
const EXCERPT_SEPARATOR = " · ";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Collapse whitespace so an excerpt is always one line. */
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * The text of a stored rich text document.
 *
 * The document is structured JSON (a `doc` of paragraphs, headings and lists
 * with inline text nodes), so the words are on the `text` field of each inline
 * node rather than in a string. A string is accepted too: a revision written by
 * an older shape should still read as something rather than disappearing from
 * the list.
 */
const richTextValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextValue).join(" ");
  if (!isRecord(value)) return "";

  const own = typeof value.text === "string" ? value.text : "";
  const children = Array.isArray(value.content)
    ? value.content.map(richTextValue).join(" ")
    : "";
  return oneLine(`${own} ${children}`);
};

/**
 * The first text field in a content record, in the order the block declares
 * its fields.
 *
 * The metadata tree is what decides what counts as text, so an image's `alt`
 * or a link's label can never be mistaken for the block's copy. A group is
 * descended into; a field that is missing or blank is skipped rather than
 * ending the walk, so a block whose first text field is empty still has a
 * chance at its second.
 */
export const firstTextField = (
  fields: readonly FieldMetadata[],
  content: Record<string, unknown>,
): string | null => {
  for (const field of fields) {
    const value = content[field.name];

    if (field.kind === "text" && typeof value === "string") {
      const text = oneLine(value);
      if (text) return text;
    }

    if (field.kind === "richText") {
      const text = oneLine(richTextValue(value));
      if (text) return text;
    }

    if (field.kind === "group" && field.fields && isRecord(value)) {
      const text = firstTextField(field.fields, value);
      if (text) return text;
    }
  }
  return null;
};

/**
 * Join the parts of an excerpt, dropping empties, and cut it to about
 * `EXCERPT_LENGTH` characters.
 *
 * The ellipsis is inside the limit rather than appended past it, so the cut is
 * exactly the length the constant promises. `trimEnd` keeps a space before the
 * ellipsis from showing as "word …".
 */
export const buildExcerpt = (
  parts: readonly (string | null | undefined)[],
): string => {
  const text = oneLine(
    parts
      .map((part) => (typeof part === "string" ? oneLine(part) : ""))
      .filter(Boolean)
      .join(EXCERPT_SEPARATOR),
  );
  if (text.length <= EXCERPT_LENGTH) return text;
  return `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
};

/**
 * A page revision's excerpt: its title, then its first block's first text
 * field.
 *
 * A page's title is a setting on the page row rather than part of the revision,
 * so every row of one page carries the same title; the block text is what
 * changes between versions. The title is dropped when the block repeats it, so
 * a hero whose heading is the page title does not read as the same words twice.
 */
export const pageExcerpt = (
  title: string,
  firstBlockText: string | null,
): string => {
  if (
    firstBlockText &&
    oneLine(title).toLowerCase() === firstBlockText.toLowerCase()
  ) {
    return buildExcerpt([title]);
  }
  return buildExcerpt([title, firstBlockText]);
};
