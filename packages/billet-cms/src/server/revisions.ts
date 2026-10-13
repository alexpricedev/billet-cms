/**
 * The newest revision for one target, shared by the preview readers.
 *
 * Both the page reader and the slot reader need "the draft the editor is
 * looking at" when a preview token names their subject, and both answer it the
 * same way: the newest `cms_revisions` row for the target. Keeping it here means
 * the two readers cannot drift in how they order or bound the query.
 */
import type { SQL } from "bun";
import { TABLES } from "../contract";

/** The newest revision id for one page or slot, or `null` when it has none. */
export const latestRevisionId = async (
  sql: SQL,
  targetType: "page" | "slot",
  targetId: string,
): Promise<string | null> => {
  const rows = (await sql.unsafe(
    `SELECT id FROM ${TABLES.revisions}
     WHERE target_type = $1 AND target_id = $2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [targetType, targetId],
  )) as { id: string }[];
  return rows[0]?.id ?? null;
};
