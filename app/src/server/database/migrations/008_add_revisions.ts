/**
 * `cms_revisions`, and the published-revision pointer on `cms_slots`.
 *
 * Every save an editor makes is one immutable row here: the content as it was
 * at that moment, who saved it and when. A slot (and, from Phase 4, a page)
 * points at the revision it has published, so history and restore are just
 * changes of pointer and nothing is overwritten in place.
 *
 * `target_type`/`target_id` are a loose polymorphic reference rather than a
 * foreign key: a revision outlives the definition it was written against (Q4 —
 * a dropped block is flagged, never deleted), and a slot can be removed while
 * its revisions stay readable. `created_by` is a `cms_identities` id, which is
 * a view over the site's users, so there is no foreign key to hang it on.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    CREATE TABLE cms_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('page', 'slot')),
      target_id UUID NOT NULL,
      content JSONB NOT NULL,
      created_by UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // The read the CMS makes on every draft: the newest revision for one target.
  await db`
    CREATE INDEX cms_revisions_target_idx
    ON cms_revisions(target_type, target_id, created_at DESC)
  `;
  await db`CREATE INDEX cms_revisions_created_by_idx ON cms_revisions(created_by)`;

  // Nullable until the slot is published (Phase 4). `ON DELETE SET NULL` so
  // deleting a revision a slot pointed at can't take the slot with it.
  await db`
    ALTER TABLE cms_slots
    ADD COLUMN published_revision_id UUID NULL
    REFERENCES cms_revisions(id) ON DELETE SET NULL
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_slots DROP COLUMN IF EXISTS published_revision_id`;
  await db`DROP TABLE IF EXISTS cms_revisions`;
};
