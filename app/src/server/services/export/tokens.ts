/**
 * Export tokens: the credentials `cms:pull` presents to `GET /export`.
 *
 * An admin creates one in the CMS; its raw value is shown once and only its
 * hash is stored, so a database dump cannot be replayed. A token is export-only
 * — there is no scope to widen — and revocable: revocation sets `revoked_at`
 * and the row stays, so the audit keeps naming it.
 *
 * Hashing is the CMS's own HMAC (`computeHMAC`), not the plain SHA-256 the
 * handoff and preview tokens use: those travel between two services that share
 * no secret, while this token is minted and checked entirely inside the CMS, so
 * it can be peppered like a session. Verification is a single indexed lookup;
 * `last_used_at` is stamped on a successful read.
 *
 * A create also stores the HMAC of the one-use nonce its form carried. That
 * nonce is not a credential — it only marks a form as spent — and the unique
 * index over it is what stops a reload from minting a second token.
 */
import { randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { computeHMAC } from "../../utils/crypto";
import { recordAudit } from "../audit";
import { db } from "../database";

const EXPORT_TOKEN_BYTES = 32;
const EXPORT_TOKEN_NONCE_BYTES = 32;

/**
 * The unique index that refuses a replayed create form.
 *
 * Migration 022 names it explicitly for this: a unique violation is only a
 * replay when it comes from this index, and `token_hash` is unique too.
 */
const CREATE_NONCE_INDEX = "cms_export_tokens_create_nonce_hash_idx";

/** The longest label the token list can show without wrapping the row. */
export const MAX_EXPORT_TOKEN_LABEL_LENGTH = 100;

/**
 * Thrown when a label is missing or too long.
 *
 * `createExportToken` is the one write path — the admin form and, later, any
 * other caller go through it — so the rule lives here, not in the form. The
 * input's `maxLength` is a convenience; this is what makes it true. The
 * controller renders `message` beside the form.
 */
export class ExportTokenLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTokenLabelError";
  }
}

/** A token as the admin list shows it: never the hash. */
export interface ExportTokenRecord {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

interface ExportTokenRow {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toRecord = (row: ExportTokenRow): ExportTokenRecord => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

/** The SHA-… HMAC hex of a raw export token, which is what the database stores. */
export const hashExportToken = (rawToken: string): string =>
  computeHMAC(rawToken);

/**
 * A fresh one-use code for the create form.
 *
 * Random rather than derived from the session: two tabs of one session each
 * need their own form, and the stored row — not the session — is what refuses
 * a replay.
 */
export const createExportTokenNonce = (): string =>
  randomBytes(EXPORT_TOKEN_NONCE_BYTES).toString("base64url");

/** The HMAC hex of a create nonce, which is what the database stores. */
export const hashExportTokenNonce = (nonce: string): string =>
  computeHMAC(nonce);

export const listExportTokens = async (): Promise<ExportTokenRecord[]> => {
  const rows = (await db`
    SELECT id, label, created_at, last_used_at, revoked_at
    FROM cms_export_tokens
    ORDER BY created_at DESC, id DESC
  `) as unknown as ExportTokenRow[];
  return rows.map(toRecord);
};

export const getExportTokenById = async (
  id: string,
): Promise<ExportTokenRecord | null> => {
  const rows = (await db`
    SELECT id, label, created_at, last_used_at, revoked_at
    FROM cms_export_tokens
    WHERE id = ${id}
  `) as unknown as ExportTokenRow[];
  return rows.length > 0 ? toRecord(rows[0]) : null;
};

export interface CreatedExportToken {
  ok: true;
  token: ExportTokenRecord;
  /** The raw token, shown once. Never stored and never returned again. */
  rawToken: string;
}

/**
 * Why a create wrote nothing.
 *
 * `nonce-missing` is a form that never carried the code. `nonce-used` is a
 * replay of a form whose token already exists — exactly what reloading the
 * create response does — and it stays a refusal rather than a second token,
 * because the raw value the first response showed is otherwise lost.
 */
export type CreateExportTokenResult =
  | CreatedExportToken
  | { ok: false; reason: "nonce-missing" | "nonce-used" };

/**
 * Whether an insert failed because the create nonce is already spent.
 *
 * The unique index is the check, not a SELECT before it: two posts of the same
 * form can race between a read and a write, and the index settles that race at
 * the only moment it can be settled. `token_hash` is unique too, so a violation
 * only counts when the index named is the nonce's — anything else is a real
 * fault and must not be reported as a replay.
 */
const isCreateNonceConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errno?: unknown }).errno;
  const index = (error as { constraint?: unknown }).constraint;
  return code === "23505" && index === CREATE_NONCE_INDEX;
};

/**
 * Create an export token and return its raw value once.
 *
 * The raw token is the only thing the caller can't re-read, so it is returned
 * from here and rendered into the response that created it. `label` is required,
 * trimmed so the list is legible, and capped at `MAX_EXPORT_TOKEN_LABEL_LENGTH`;
 * an empty or over-long one throws `ExportTokenLabelError` before any write.
 *
 * `nonce` is the one-use code the form carried. A blank one is refused before
 * the insert; one already stored comes back as `nonce-used` with nothing
 * written, so a replayed post can't mint a second token.
 */
export const createExportToken = async (input: {
  label: string;
  nonce: string;
  actorId: string | null;
}): Promise<CreateExportTokenResult> => {
  const label = input.label.trim();
  if (label === "") {
    throw new ExportTokenLabelError("Name this token so you can recognise it.");
  }
  if (label.length > MAX_EXPORT_TOKEN_LABEL_LENGTH) {
    throw new ExportTokenLabelError(
      `Use ${MAX_EXPORT_TOKEN_LABEL_LENGTH} characters or fewer.`,
    );
  }

  const nonce = input.nonce.trim();
  if (nonce === "") return { ok: false, reason: "nonce-missing" };

  const rawToken = randomBytes(EXPORT_TOKEN_BYTES).toString("base64url");

  let rows: ExportTokenRow[];
  try {
    rows = (await db`
      INSERT INTO cms_export_tokens
        (label, token_hash, create_nonce_hash, created_by)
      VALUES (
        ${label},
        ${hashExportToken(rawToken)},
        ${hashExportTokenNonce(nonce)},
        ${input.actorId}
      )
      RETURNING id, label, created_at, last_used_at, revoked_at
    `) as unknown as ExportTokenRow[];
  } catch (error) {
    if (isCreateNonceConflict(error)) {
      return { ok: false, reason: "nonce-used" };
    }
    throw error;
  }

  const token = toRecord(rows[0]);
  await recordAudit({
    action: "export_token.created",
    actorId: input.actorId,
    subjectType: "export_token",
    subjectId: token.id,
    detail: { label },
  });

  return { ok: true, token, rawToken };
};

export type RevokeExportTokenResult =
  | { ok: true; token: ExportTokenRecord }
  | { ok: false; reason: "not-found" };

/**
 * Revoke a token. Retires it by setting `revoked_at`, never deleting the row,
 * so the audit keeps a name for it. Revoking twice is a no-op that still
 * reports success.
 */
export const revokeExportToken = async (
  id: string,
  actorId: string | null,
): Promise<RevokeExportTokenResult> => {
  const rows = (await db`
    UPDATE cms_export_tokens
    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE id = ${id}
    RETURNING id, label, created_at, last_used_at, revoked_at
  `) as unknown as ExportTokenRow[];

  if (rows.length === 0) return { ok: false, reason: "not-found" };

  const token = toRecord(rows[0]);
  await recordAudit({
    action: "export_token.revoked",
    actorId,
    subjectType: "export_token",
    subjectId: token.id,
    detail: { label: token.label },
  });

  return { ok: true, token };
};

/**
 * The token a raw value names, when it is live, updating `last_used_at`.
 *
 * A revoked or unknown token is `null`. The conditional UPDATE is the whole
 * check: a token revoked between the admin list rendering and this read is
 * refused here, so there is no window between a SELECT and a use.
 */
export const verifyExportToken = async (
  rawToken: string,
  sql: SQL = db,
): Promise<ExportTokenRecord | null> => {
  const rows = (await sql`
    UPDATE cms_export_tokens
    SET last_used_at = CURRENT_TIMESTAMP
    WHERE token_hash = ${hashExportToken(rawToken)}
      AND revoked_at IS NULL
    RETURNING id, label, created_at, last_used_at, revoked_at
  `) as unknown as ExportTokenRow[];

  return rows.length > 0 ? toRecord(rows[0]) : null;
};
