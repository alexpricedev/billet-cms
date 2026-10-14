/**
 * `cms_audit`: the append-only record of privileged actions.
 *
 * Only a handful of things write here — export tokens created and revoked, and
 * exports read — so it stays small and is never the thing a page waits on. A
 * record is best-effort: the action it describes has already committed, and a
 * failure to log must not undo it or 500 the request, so `recordAudit` catches
 * and reports rather than throwing.
 *
 * `actorId` names a `cms_identities` id when a person acted, or an export
 * token's id when the token authenticated the request, and `subjectType` says
 * which. There is no foreign key: identities belong to the site's `users`, and
 * a token an admin deleted should still read in the log.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { jsonbValue } from "../utils/sql";
import { db } from "./database";
import { log } from "./logger";

export interface AuditRecord {
  /** A stable machine name, e.g. `export_token.created`. */
  action: string;
  /** The identity (or token) that acted. */
  actorId?: string | null;
  /** `identity` or `export_token`. */
  subjectType?: string | null;
  subjectId?: string | null;
  /** Free-form detail for a human reading the log. */
  detail?: Record<string, unknown>;
}

/**
 * Append one audit row.
 *
 * Returns whether it was written. A database that is unreachable is logged and
 * swallowed: the caller's action already happened, and a failure to describe it
 * is not a reason to fail the request.
 */
export const recordAudit = async (
  record: AuditRecord,
  sql: SQL = db,
): Promise<boolean> => {
  try {
    await sql`
      INSERT INTO cms_audit
        (id, action, actor_id, subject_type, subject_id, detail)
      VALUES (
        ${randomUUID()},
        ${record.action},
        ${record.actorId ?? null},
        ${record.subjectType ?? null},
        ${record.subjectId ?? null},
        ${jsonbValue(record.detail ?? {})}
      )
    `;
    return true;
  } catch (error) {
    log.warn(
      "audit",
      `Could not write the audit record for ${record.action}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
};
