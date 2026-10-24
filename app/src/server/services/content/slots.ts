/**
 * Reading the slots a site's templates declared.
 *
 * A slot is the unit an editor fills: one named hole in a template, backed by
 * one block type. The CMS lists slots by the page they belong to, which is the
 * `page` the publish derived from the slot name.
 */
import { db } from "../database";

export interface SlotRecord {
  id: string;
  name: string;
  blockName: string;
  page: string;
  /** The site path whose Preview opens this slot, e.g. `/` or `/contact`. */
  previewPath: string;
  label: string | null;
  help: string | null;
  removedAt: Date | null;
  publishedRevisionId: string | null;
}

interface SlotRow {
  id: string;
  name: string;
  block_name: string;
  page: string;
  preview_path: string;
  label: string | null;
  help: string | null;
  removed_at: Date | null;
  published_revision_id: string | null;
}

const toSlot = (row: SlotRow): SlotRecord => ({
  id: row.id,
  name: row.name,
  blockName: row.block_name,
  page: row.page,
  previewPath: row.preview_path,
  label: row.label,
  help: row.help,
  removedAt: row.removed_at,
  publishedRevisionId: row.published_revision_id,
});

export const listSlots = async (): Promise<SlotRecord[]> => {
  const rows = (await db`
    SELECT id, name, block_name, page, preview_path, label, help, removed_at,
           published_revision_id
    FROM cms_slots
    ORDER BY page, name
  `) as SlotRow[];
  return rows.map(toSlot);
};

export type SlotState =
  | { kind: "live" }
  | { kind: "draft"; since: Date }
  | { kind: "never" };

interface SlotStateRow {
  id: string;
  published_revision_id: string | null;
  latest_id: string | null;
  latest_created_at: Date | null;
}

/**
 * Whether each slot's newest edit is live, in one query for the whole list.
 *
 * The newest revision is the draft (same ordering as `getLatestRevision`); a
 * slot with no published revision is "never", whatever drafts it has.
 */
export const listSlotStates = async (): Promise<Map<string, SlotState>> => {
  const rows = (await db`
    SELECT s.id, s.published_revision_id,
           latest.id AS latest_id, latest.created_at AS latest_created_at
    FROM cms_slots s
    LEFT JOIN LATERAL (
      SELECT id, created_at
      FROM cms_revisions
      WHERE target_type = 'slot' AND target_id = s.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest ON true
  `) as SlotStateRow[];

  const states = new Map<string, SlotState>();
  for (const row of rows) {
    if (row.published_revision_id === null) {
      states.set(row.id, { kind: "never" });
    } else if (
      row.latest_id !== null &&
      row.latest_id !== row.published_revision_id &&
      row.latest_created_at
    ) {
      states.set(row.id, { kind: "draft", since: row.latest_created_at });
    } else {
      states.set(row.id, { kind: "live" });
    }
  }
  return states;
};

export const getSlotById = async (id: string): Promise<SlotRecord | null> => {
  const rows = (await db`
    SELECT id, name, block_name, page, preview_path, label, help, removed_at,
           published_revision_id
    FROM cms_slots
    WHERE id = ${id}
  `) as SlotRow[];
  return rows.length > 0 ? toSlot(rows[0]) : null;
};

export interface SlotPageGroup {
  page: string;
  slots: SlotRecord[];
}

/** The slots grouped by the page they are listed under, pages in name order. */
export const groupSlotsByPage = (slots: SlotRecord[]): SlotPageGroup[] => {
  const groups = new Map<string, SlotRecord[]>();
  for (const slot of slots) {
    const existing = groups.get(slot.page);
    if (existing) existing.push(slot);
    else groups.set(slot.page, [slot]);
  }

  return [...groups.entries()]
    .map(([page, pageSlots]) => ({ page, slots: pageSlots }))
    .sort((a, b) => a.page.localeCompare(b.page));
};
