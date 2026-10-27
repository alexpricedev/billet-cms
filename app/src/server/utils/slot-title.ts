import { humanise } from "./humanise";

/** A slot in an editor's words: its label, else its key humanised. */
export const slotTitle = (slot: { label: string | null; name: string }) =>
  slot.label ?? humanise(slot.name);
