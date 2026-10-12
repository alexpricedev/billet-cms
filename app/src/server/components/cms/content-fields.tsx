import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { FieldControl } from "../../components/cms/field-control";

export interface ContentFieldsProps {
  fields: FieldMetadata[];
  content: Record<string, unknown>;
}

/** The generated controls for one block's fields, keyed by the stored content. */
export const ContentFields = ({ fields, content }: ContentFieldsProps) => (
  <div className="cms-fields" data-cms-fields>
    {fields.map((field) => (
      <FieldControl
        key={field.name}
        field={field}
        value={content[field.name]}
      />
    ))}
  </div>
);
