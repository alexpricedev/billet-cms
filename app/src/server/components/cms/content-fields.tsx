import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import {
  FieldControl,
  type FieldError,
} from "../../components/cms/field-control";

export interface ContentFieldsProps {
  fields: FieldMetadata[];
  content: Record<string, unknown>;
  /** Validation messages for a top-level field, keyed by its name. */
  errorsByField?: Map<string, FieldError[]>;
}

/** The generated controls for one block's fields, keyed by the stored content. */
export const ContentFields = ({
  fields,
  content,
  errorsByField,
}: ContentFieldsProps) => (
  <div className="cms-fields" data-cms-fields>
    {fields.map((field) => (
      <FieldControl
        key={field.name}
        field={field}
        value={content[field.name]}
        idBase={`cms-field-${field.name}`}
        errors={errorsByField?.get(field.name)}
      />
    ))}
  </div>
);
