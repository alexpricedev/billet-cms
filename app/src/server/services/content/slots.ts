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
  label: row.label,
  help: row.help,
  removedAt: row.removed_at,
  publishedRevisionId: row.published_revision_id,
});

export const listSlots = async (): Promise<SlotRecord[]> => {
  const rows = (await db`
    SELECT id, name, block_name, page, label, help, removed_at,
           published_revision_id
    FROM cms_slots
    ORDER BY page, name
  `) as SlotRow[];
  return rows.map(toSlot);
};

export const getSlotById = async (id: string): Promise<SlotRecord | null> => {
  const rows = (await db`
    SELECT id, name, block_name, page, label, help, removed_at,
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
