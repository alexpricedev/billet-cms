/**
 * `cms_pages.draft_url`: a page's address waiting for Publish.
 *
 * A page's URL used to change on Save draft, so a draft of a published page
 * moved the live address — and wrote its redirect — before anyone published.
 * The new address is now stored here instead: `url` stays the live address the
 * site serves, and Publish applies `draft_url` in the same transaction as the
 * rest of the publish. Nullable, so every existing page keeps the address it
 * already has. No index: uniqueness across `url` and `draft_url` is checked at
 * save in code. Older readers ignore the column, so `CONTRACT_VERSION` stays.
 */
import type { SQL } from "bun";

export const up = async (db: SQL): Promise<void> => {
  await db`
    ALTER TABLE cms_pages
      ADD COLUMN draft_url TEXT NULL
  `;
};

export const down = async (db: SQL): Promise<void> => {
  await db`ALTER TABLE cms_pages DROP COLUMN IF EXISTS draft_url`;
};
