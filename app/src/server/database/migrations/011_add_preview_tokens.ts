/**
 * `cms_preview_tokens`, and the preview path on `cms_slots`.
 *
 * Preview is the CMS showing an editor the *draft* on the real site. The token
 * is the whole mechanism: the CMS mints one row here for a single subject (one
 * page or one slot), opens `<site><path>?cms_preview=…`, and the plugin checks
 * the row before it renders. Only the SHA-256 of the raw token is stored, so a
 * database dump can't be replayed as a preview, and `expires_at` is what makes
 * the link short-lived — nothing else revokes it.
 *
 * `subject_type`/`subject_id` are a loose polymorphic reference, exactly like a
 * revision's: a page or slot a deploy removed stays readable, so a preview
 * minted just before a deploy still resolves. There is no foreign key to hang
 * either on for the same reason, and because the table is swept rather than
 * cascaded.
 *
 * `cms_slots.preview_path` is the site path whose Preview opens the slot (the
 * home page for a header slot, or a specific page). It is what lets the CMS's
 * Preview button open the *real* page a slot lives on; the plugin declares it
 * with the slot and publishes it, defaulting to `/`.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_preview_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject_type VARCHAR(20) NOT NULL CHECK (subject_type IN ('page', 'slot')),
      subject_id UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by UUID NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // The two reads the table serves: the plugin looks a token up by hash, and the
  // cleanup sweep deletes expired rows.
  await db`
    CREATE INDEX cms_preview_tokens_subject_idx
    ON cms_preview_tokens(subject_type, subject_id)
  `;
  await db`
    CREATE INDEX cms_preview_tokens_expires_at_idx
    ON cms_preview_tokens(expires_at)
  `;

  await db`
    ALTER TABLE cms_slots
    ADD COLUMN preview_path TEXT NOT NULL DEFAULT '/'
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_slots DROP COLUMN IF EXISTS preview_path`;
  await db`DROP TABLE IF EXISTS cms_preview_tokens`;
};
