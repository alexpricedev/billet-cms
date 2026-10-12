import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import type { JSX } from "preact";
import { RichTextView } from "./rich-text";

/**
 * One CMS form control, generated from the field metadata a site published.
 *
 * The CMS never imported the site's block code, so everything here comes from
 * `FieldMetadata`: the kind picks the control, `max`/`min` the limits, and for a
 * list the item metadata is nested under `of`, which is what lets a repeatable
 * control be built recursively.
 *
 * Controls are `data-*` driven rather than named inputs. The editor's save is a
 * single hidden `content` field holding the whole JSON document (see the
 * `cms-form` client script): with JavaScript on, that field is rebuilt from
 * these controls; with it off, the stored JSON is submitted unchanged, so the
 * form still round-trips a save that changes nothing.
 */

const EMPTY_DOCUMENT: RichTextDocument = { type: "doc", content: [] };

const asRichTextDocument = (value: unknown): RichTextDocument => {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "doc"
  ) {
    return value as RichTextDocument;
  }
  return EMPTY_DOCUMENT;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

interface ValueRecord {
  [key: string]: unknown;
}

const asRecord = (value: unknown): ValueRecord =>
  typeof value === "object" && value !== null ? (value as ValueRecord) : {};

export interface FieldControlProps {
  field: FieldMetadata;
  value: unknown;
}

const FieldLabel = ({ field }: { field: FieldMetadata }): JSX.Element => (
  <span className="cms-field-label">
    {field.label ?? field.name}
    {field.required && <span className="cms-required"> *</span>}
  </span>
);

const FieldHelp = ({ help }: { help?: string }): JSX.Element | null =>
  help ? <span className="cms-field-help">{help}</span> : null;

const RichTextToolbar = (): JSX.Element => (
  <div className="cms-rte-toolbar" role="toolbar" aria-label="Formatting">
    <button type="button" data-rich-command="bold" title="Bold">
      B
    </button>
    <button type="button" data-rich-command="italic" title="Italic">
      I
    </button>
    <button type="button" data-rich-command="h2" title="Heading 2">
      H2
    </button>
    <button type="button" data-rich-command="h3" title="Heading 3">
      H3
    </button>
    <button type="button" data-rich-command="h4" title="Heading 4">
      H4
    </button>
    <button type="button" data-rich-command="paragraph" title="Paragraph">
      ¶
    </button>
    <button type="button" data-rich-command="bulletList" title="Bullet list">
      •
    </button>
    <button type="button" data-rich-command="orderedList" title="Numbered list">
      1.
    </button>
    <button type="button" data-rich-command="link" title="Link">
      Link
    </button>
  </div>
);

const ListItemControl = ({ field, value }: FieldControlProps): JSX.Element => (
  <div className="cms-list-item" data-list-item>
    <FieldControl field={field} value={value} />
    <button type="button" className="cms-list-remove" data-list-remove>
      Remove
    </button>
  </div>
);

export const FieldControl = ({
  field,
  value,
}: FieldControlProps): JSX.Element => {
  switch (field.kind) {
    case "text":
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="text"
          data-field-name={field.name}
        >
          <FieldLabel field={field} />
          <input
            type="text"
            data-text-input
            value={asString(value)}
            maxLength={field.max}
          />
          <FieldHelp help={field.help} />
        </div>
      );

    case "richText":
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="richText"
          data-field-name={field.name}
          data-rich-text-field
        >
          <FieldLabel field={field} />
          <input
            type="hidden"
            data-rich-text-value
            value={JSON.stringify(asRichTextDocument(value))}
          />
          <RichTextToolbar />
          <div className="cms-rich-text" data-rich-text contentEditable={true}>
            <RichTextView document={asRichTextDocument(value)} />
          </div>
          <FieldHelp help={field.help} />
        </div>
      );

    case "image": {
      const image = asRecord(value);
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="image"
          data-field-name={field.name}
        >
          <FieldLabel field={field} />
          <input
            type="text"
            data-image-id
            placeholder="Media id"
            value={asString(image.mediaId)}
          />
          <input
            type="text"
            data-image-alt
            placeholder="Alt text"
            value={asString(image.alt)}
          />
          <FieldHelp help={field.help} />
          {field.image?.minWidth && (
            <span className="cms-field-help">
              Needs at least {field.image.minWidth}px wide
            </span>
          )}
        </div>
      );
    }

    case "link": {
      const link = asRecord(value);
      const type = link.type === "page" ? "page" : "url";
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="link"
          data-field-name={field.name}
        >
          <FieldLabel field={field} />
          <select data-link-type value={type}>
            <option value="url">External URL</option>
            <option value="page">CMS page</option>
          </select>
          <input
            type="text"
            data-link-url
            placeholder="https://…"
            value={asString(link.url)}
          />
          <input
            type="text"
            data-link-page
            placeholder="Page id"
            value={asString(link.pageId)}
          />
          <input
            type="text"
            data-link-label
            placeholder="Label"
            value={asString(link.label)}
          />
          <label className="cms-field-checkbox">
            <input
              type="checkbox"
              data-link-newtab
              checked={link.newTab === true}
            />
            Open in a new tab
          </label>
          <FieldHelp help={field.help} />
        </div>
      );
    }

    case "list": {
      const items = Array.isArray(value) ? value : [];
      const itemField = field.of;
      if (!itemField) {
        return (
          <div
            className="cms-field"
            data-field
            data-field-kind="list"
            data-field-name={field.name}
          >
            <FieldLabel field={field} />
            <span className="cms-field-help">
              This list has no item metadata published; it can't be edited.
            </span>
          </div>
        );
      }

      // An empty list still renders one row, so a required list has somewhere
      // to type before the editor adds a second entry.
      const rows = items.length > 0 ? items : [undefined];

      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="list"
          data-field-name={field.name}
          data-list
          data-max={field.max}
          data-min={field.min}
        >
          <FieldLabel field={field} />
          <div data-list-items>
            {rows.map((item, index) => (
              <ListItemControl key={index} field={itemField} value={item} />
            ))}
          </div>
          {/* Cloned by the editor when an item is added. Never in the form's
              query scope, so it is not serialised with the real rows. */}
          <template data-list-template>
            <ListItemControl field={itemField} value={undefined} />
          </template>
          <button type="button" className="cms-list-add" data-list-add>
            Add item
          </button>
          <FieldHelp help={field.help} />
        </div>
      );
    }
  }
};
