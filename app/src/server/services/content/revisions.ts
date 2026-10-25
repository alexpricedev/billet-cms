/**
 * Revisions: one immutable row per save.
 *
 * Every draft an editor saves is appended here, never updated in place. The
 * newest row for a target is the draft; the target's `published_revision_id`
 * (Phase 4) will point at the one the site reads. History and restore are
 * therefore just queries over this table, and a conflict is a revision that
 * arrived after the one the editor loaded.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { jsonbValue } from "../../utils/sql";
import { db } from "../database";

export type RevisionTargetType = "page" | "slot";

export interface RevisionRecord {
  id: string;
  targetType: RevisionTargetType;
  targetId: string;
  content: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
}

interface RevisionRow {
  id: string;
  target_type: RevisionTargetType;
  target_id: string;
  content: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
}

const toRevision = (row: RevisionRow): RevisionRecord => ({
  id: row.id,
  targetType: row.target_type,
  targetId: row.target_id,
  content: row.content,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

/**
 * Read one revision.
 *
 * `sql` is threaded through so the write layer's transaction can read and write
 * under one lock: passing the transaction is what makes a conflict check and
 * the insert that follows it a single step.
 */
export const getRevisionById = async (
  id: string,
  sql: SQL = db,
): Promise<RevisionRecord | null> => {
  const rows = (await sql`
    SELECT id, target_type, target_id, content, created_by, created_at
    FROM cms_revisions
    WHERE id = ${id}
  `) as RevisionRow[];
  return rows.length > 0 ? toRevision(rows[0]) : null;
};

/** The newest revision for a target, which is the draft an editor loads. */
export const getLatestRevision = async (
  targetType: RevisionTargetType,
  targetId: string,
  sql: SQL = db,
): Promise<RevisionRecord | null> => {
  const rows = (await sql`
    SELECT id, target_type, target_id, content, created_by, created_at
    FROM cms_revisions
    WHERE target_type = ${targetType} AND target_id = ${targetId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as RevisionRow[];
  return rows.length > 0 ? toRevision(rows[0]) : null;
};

export interface CreateRevisionInput {
  targetType: RevisionTargetType;
  targetId: string;
  content: Record<string, unknown>;
  createdBy: string | null;
  /** The revision a restore copied, when this row is a restore. */
  restoredFrom?: string | null;
}

export const createRevision = async (
  input: CreateRevisionInput,
  sql: SQL = db,
): Promise<RevisionRecord> => {
  const rows = (await sql`
    INSERT INTO cms_revisions (id, target_type, target_id, content, created_by, restored_from)
    VALUES (
      ${randomUUID()},
      ${input.targetType},
      ${input.targetId},
      ${jsonbValue(input.content)},
      ${input.createdBy},
      ${input.restoredFrom ?? null}
    )
    RETURNING id, target_type, target_id, content, created_by, created_at
  `) as RevisionRow[];

  return toRevision(rows[0]);
};
