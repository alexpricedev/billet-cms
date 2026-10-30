import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import {
  FieldControl,
  type FieldError,
} from "../../components/cms/field-control";
import type { PickerImage } from "../../components/cms/image-picker";
import type { PageOption } from "../../services/content/pages";

export interface ContentFieldsProps {
  fields: FieldMetadata[];
  content: Record<string, unknown>;
  /** Validation messages for a top-level field, keyed by its name. */
  errorsByField?: Map<string, FieldError[]>;
  /** The CMS pages a `link` field's picker offers. */
  pages?: PageOption[];
  /**
   * The uploads an `image` field currently references, keyed by media id. One
   * map serves every field (and every list row) on the form.
   */
  pickerImages?: Map<string, PickerImage>;
  /** The CSRF token bound to `POST /cms/media`, for the pickers' drop zones. */
  uploadCsrfToken?: string;
  /**
   * Id prefix for the controls. A page renders one block per `ContentFields`,
   * and two blocks can declare the same field name, so the block's own prefix
   * keeps the ids unique (and the labels pointing at the right control).
   */
  idPrefix?: string;
}

/** The generated controls for one block's fields, keyed by the stored content. */
export const ContentFields = ({
  fields,
  content,
  errorsByField,
  pages,
  pickerImages,
  uploadCsrfToken,
  idPrefix = "cms-field",
}: ContentFieldsProps) => (
  <div className="cms-fields" data-cms-fields>
    {fields.map((field) => (
      <FieldControl
        key={field.name}
        field={field}
        value={content[field.name]}
        idBase={`${idPrefix}-${field.name}`}
        errors={errorsByField?.get(field.name)}
        pages={pages}
        pickerImages={pickerImages}
        uploadCsrfToken={uploadCsrfToken}
      />
    ))}
  </div>
);
