import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";

/**
 * Fields saved content carries that the current schema no longer declares (Q4).
 *
 * A deploy can drop a field from a block; the data written when it existed
 * stays in every revision that has it. The editor flags those keys, keeps them
 * out of the generated controls, and carries their values through a save
 * untouched — never deleting content because the code stopped describing it.
 */
export interface RemovedFields {
  names: string[];
  values: Record<string, unknown>;
}

export const findRemovedFields = (
  content: Record<string, unknown>,
  fields: FieldMetadata[],
): RemovedFields => {
  const known = new Set(fields.map((field) => field.name));
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    if (!known.has(key)) values[key] = value;
  }

  return { names: Object.keys(values), values };
};
