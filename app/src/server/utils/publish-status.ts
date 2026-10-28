import { formatWhen } from "./format";

export interface PublishStatusInput {
  /** When the newest revision was saved; null when nothing was ever saved. */
  latestRevisionAt: Date | null;
  /** Whether the newest revision is already the one the site renders. */
  upToDate: boolean;
  /** Whether anything is live at all. */
  published: boolean;
  /** When the live revision was saved; null when nothing is live. */
  publishedRevisionAt: Date | null;
}

/**
 * What is live and what is draft, in one sentence.
 *
 * Both halves are stated, because "Published." left an editor unable to tell
 * whether the words on screen were the ones the site was serving. Times come
 * from the revisions themselves and are labelled UTC, as History labels them:
 * the CMS has no per-editor timezone to render them in.
 */
export const publishStatusLine = ({
  latestRevisionAt,
  upToDate,
  published,
  publishedRevisionAt,
}: PublishStatusInput): string => {
  if (!latestRevisionAt) return "No draft saved yet.";
  if (!published || !publishedRevisionAt) {
    return `Not published yet. Draft saved ${formatWhen(latestRevisionAt)} UTC.`;
  }
  if (upToDate) {
    return `Live since ${formatWhen(publishedRevisionAt)} UTC. No unpublished changes.`;
  }
  return `Live since ${formatWhen(publishedRevisionAt)} UTC. Draft saved ${formatWhen(latestRevisionAt)} UTC, not published yet.`;
};

/**
 * Why Publish is greyed out, or null when it is enabled.
 *
 * A disabled button with no explanation reads as a broken one: the editor has
 * no way to tell "nothing to publish" from "this failed to load".
 */
export const publishReason = (
  hasDraft: boolean,
  upToDate: boolean,
): string | null => {
  if (!hasDraft) return "Nothing to publish: no draft saved yet.";
  if (upToDate) return "Nothing to publish: no unpublished changes.";
  return null;
};

/** Why Preview draft is greyed out, or null when it is enabled. */
export const previewReason = (
  hasDraft: boolean,
  upToDate: boolean,
): string | null => {
  if (!hasDraft) return "No draft to preview.";
  if (upToDate) return "Nothing to preview: no unpublished changes.";
  return null;
};
