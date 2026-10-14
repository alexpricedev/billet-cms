/**
 * `cms_export_tokens` and `cms_audit`.
 *
 * Export is how a local or preview environment pulls production content without
 * database credentials: an admin creates a token in the CMS, and `cms:pull`
 * presents it to `GET /export`. The token is export-only — there is no scope
 * column, because a token can do exactly one thing — stored hashed (its raw
 * value exists once, in the response that created it) and revocable, never
 * expiring on a clock.
 *
 * `label` is a human name so an admin can tell two tokens apart in the list;
 * `last_used_at` is stamped when the token authenticates an export, and
 * `revoked_at` retires a token without deleting the row, so the audit keeps
 * naming it.
 *
 * `cms_audit` is append-only: one row per export token created, revoked, or
 * used to read an export. `actor_id` is a `cms_identities` id when a person did
 * it (a token id when the token itself authenticated a read), with no foreign
 * key because identities belong to the site's `users`, not to a CMS table.
 * `detail` is free-form JSONB for counts and names a human reading the log
 * wants.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_export_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMPTZ NULL,
      revoked_at TIMESTAMPTZ NULL
    )
  `;

  // The admin list reads newest first; revocation scopes by primary key, so no
  // index is needed for it.
  await db`
    CREATE INDEX cms_export_tokens_created_at_idx
    ON cms_export_tokens(created_at DESC)
  `;

  await db`
    CREATE TABLE cms_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action TEXT NOT NULL,
      actor_id UUID NULL,
      subject_type TEXT NULL,
      subject_id UUID NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // The audit log is read newest first, and (rarely) filtered by action.
  await db`
    CREATE INDEX cms_audit_created_at_idx ON cms_audit(created_at DESC)
  `;
  await db`CREATE INDEX cms_audit_action_idx ON cms_audit(action)`;
};

export const down = async (db: SQL): Promise<void> => {
  await db`DROP TABLE IF EXISTS cms_audit`;
  await db`DROP TABLE IF EXISTS cms_export_tokens`;
};
