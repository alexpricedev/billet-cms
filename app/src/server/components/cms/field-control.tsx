import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import type { ComponentChildren, JSX } from "preact";
import type { PageOption } from "../../services/content/pages";
import type { MediaOption } from "../../services/media";
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
 *
 * Every control carries an accessible name: a `<label for>` where one control
 * matches the field, a `<fieldset>`/`<legend>` where several do. A list row has
 * no stable id — a row can be cloned — so it is named with `aria-label`
 * instead.
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

/** One validation message, pointing at a field by dotted path. */
export interface FieldError {
  path: string;
  message: string;
}

export interface FieldControlProps {
  field: FieldMetadata;
  value: unknown;
  /** Id base for the label/control pair; absent for a row without a stable id. */
  idBase?: string;
  /** Validation messages for this control, if any. */
  errors?: FieldError[];
  /**
   * An accessible name to use instead of the field's own label. List rows use
   * it: a row's item field is named "item" in the metadata, so the list's own
   * label — "Tags" rather than a second "item" — names each row. A row is also
   * where ids stop, because a cloned row would repeat them.
   */
  labelOverride?: string;
  /** The CMS pages a `link` field may point at, for the internal-link picker. */
  pages?: PageOption[];
  /**
   * The uploads an `image` field may reuse. The options themselves are rendered
   * once per form by `MediaOptionsTemplate`; this only says whether a picker is
   * worth showing, so a 400-upload library does not repeat 400 options in every
   * image field.
   */
  media?: MediaOption[];
}

/**
 * The image picker's options, rendered once for the whole form.
 *
 * A form with many image fields — and several list rows each — would otherwise
 * render the whole reuse list per field. The client copies options out of this
 * one template into a picker when it is first focused, so the library is in the
 * document once, not once per control.
 */
export const MediaOptionsTemplate = ({
  media,
}: {
  media?: MediaOption[];
}): JSX.Element | null =>
  media && media.length > 0 ? (
    <template data-media-options>
      {media.map((option) => (
        <option key={option.id} value={option.id}>
          {option.alt} ({option.width}×{option.height})
        </option>
      ))}
    </template>
  ) : null;

const describedBy = (...ids: (string | undefined)[]): string | undefined => {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
};

const fieldName = (field: FieldMetadata): string => field.label ?? field.name;

/**
 * A list field's help text, with its maximum spelled out.
 *
 * The Add button disables at `max`, so the editor is told "Up to N items"
 * instead of discovering the limit through a refused save. The field's own
 * `help` is kept and the limit joined into the single help element the
 * control's `aria-describedby` points at.
 */
const listHelp = (field: FieldMetadata): string | undefined => {
  const limit =
    field.max === undefined
      ? null
      : `Up to ${field.max} ${field.max === 1 ? "item" : "items"}.`;
  if (field.help && limit) return `${field.help} ${limit}`;
  return field.help ?? limit ?? undefined;
};

const FieldLabelText = ({ field }: { field: FieldMetadata }): JSX.Element => (
  <>
    {fieldName(field)}
    {field.required && <span className="cms-required"> *</span>}
  </>
);

const FieldHelp = ({
  help,
  id,
}: {
  help?: string;
  id?: string;
}): JSX.Element | null =>
  help ? (
    <span className="cms-field-help" id={id}>
      {help}
    </span>
  ) : null;

const FieldErrors = ({
  errors,
  id,
}: {
  errors?: FieldError[];
  id?: string;
}): JSX.Element | null =>
  errors && errors.length > 0 ? (
    <ul className="cms-field-errors" id={id}>
      {errors.map((error, index) => (
        <li key={`${error.path}:${index}`}>{error.message}</li>
      ))}
    </ul>
  ) : null;

const RichTextToolbar = ({ editorId }: { editorId?: string }): JSX.Element => (
  <div
    className="cms-rte-toolbar"
    role="toolbar"
    aria-label="Formatting"
    aria-controls={editorId}
  >
    <button
      type="button"
      data-rich-command="bold"
      aria-label="Bold"
      title="Bold"
    >
      B
    </button>
    <button
      type="button"
      data-rich-command="italic"
      aria-label="Italic"
      title="Italic"
    >
      I
    </button>
    <button
      type="button"
      data-rich-command="h2"
      aria-label="Heading 2"
      title="Heading 2"
    >
      H2
    </button>
    <button
      type="button"
      data-rich-command="h3"
      aria-label="Heading 3"
      title="Heading 3"
    >
      H3
    </button>
    <button
      type="button"
      data-rich-command="h4"
      aria-label="Heading 4"
      title="Heading 4"
    >
      H4
    </button>
    <button
      type="button"
      data-rich-command="paragraph"
      aria-label="Paragraph"
      title="Paragraph"
    >
      ¶
    </button>
    <button
      type="button"
      data-rich-command="bulletList"
      aria-label="Bullet list"
      title="Bullet list"
    >
      •
    </button>
    <button
      type="button"
      data-rich-command="orderedList"
      aria-label="Numbered list"
      title="Numbered list"
    >
      1.
    </button>
    <button
      type="button"
      data-rich-command="link"
      aria-label="Link"
      title="Link"
    >
      Link
    </button>
  </div>
);

const SUBLABEL_CLASS = "cms-field-sublabel";

/**
 * A small label for one control inside a composite field.
 *
 * It is a real `<label for>` when the control has an id, and a plain span when
 * it does not (a list row); the control carries `aria-label` in that case.
 */
const SubControlLabel = ({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: ComponentChildren;
}): JSX.Element =>
  htmlFor ? (
    <label className={SUBLABEL_CLASS} htmlFor={htmlFor}>
      {children}
    </label>
  ) : (
    <span className={SUBLABEL_CLASS}>{children}</span>
  );

const ListItemControl = ({
  field,
  value,
  listLabel,
  pages,
  media,
}: {
  field: FieldMetadata;
  value: unknown;
  /** The list's own label, so every Add/Remove names the list it belongs to. */
  listLabel: string;
  pages?: PageOption[];
  media?: MediaOption[];
}): JSX.Element => (
  <div className="cms-list-item" data-list-item>
    <FieldControl
      field={field}
      value={value}
      labelOverride={listLabel}
      pages={pages}
      media={media}
    />
    <button
      type="button"
      className="cms-list-remove"
      data-list-remove
      aria-label={`Remove from ${listLabel}`}
    >
      Remove
    </button>
  </div>
);

export const FieldControl = ({
  field,
  value,
  idBase,
  errors,
  labelOverride,
  pages,
  media,
}: FieldControlProps): JSX.Element => {
  const required = field.required;
  const invalid = errors && errors.length > 0;
  // Rows pass no idBase: their controls are named by `aria-label` alone.
  const controlId = labelOverride ? undefined : (idBase ?? field.name);
  const idFor = (suffix: string): string | undefined =>
    controlId ? `${controlId}-${suffix}` : undefined;
  const helpId = idFor("help");
  const errorId = idFor("error");
  const described = describedBy(helpId, errorId);

  switch (field.kind) {
    case "text":
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="text"
          data-field-name={field.name}
        >
          {labelOverride ? (
            <span className="cms-field-label">{labelOverride}</span>
          ) : (
            <label className="cms-field-label" htmlFor={controlId}>
              <FieldLabelText field={field} />
            </label>
          )}
          <input
            type="text"
            id={controlId}
            data-text-input
            value={asString(value)}
            maxLength={field.max}
            aria-label={labelOverride}
            aria-required={required ? "true" : undefined}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={described}
          />
          <FieldErrors errors={errors} id={errorId} />
          <FieldHelp help={field.help} id={helpId} />
        </div>
      );

    case "richText": {
      // The editor carries the id, not the fieldset: two elements sharing one
      // id makes the label point at whichever the browser saw last, and the
      // editor — the actual textbox — would have no name of its own.
      const labelId = idFor("label");
      return (
        <fieldset
          className="cms-field"
          data-field
          data-field-kind="richText"
          data-field-name={field.name}
          data-rich-text-field
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label" id={labelId}>
              {labelOverride}
            </span>
          ) : (
            <legend className="cms-field-label" id={labelId}>
              <FieldLabelText field={field} />
            </legend>
          )}
          <RichTextToolbar editorId={controlId} />
          {/* biome-ignore lint/a11y/useSemanticElements: a rich text editor is a contenteditable document, not a single-line input or a textarea */}
          <div
            className="cms-rich-text"
            id={controlId}
            data-rich-text
            contentEditable={true}
            tabIndex={0}
            role="textbox"
            aria-multiline="true"
            aria-labelledby={controlId ? labelId : undefined}
            aria-label={controlId ? undefined : labelOverride}
            aria-required={required ? "true" : undefined}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={described}
          >
            <RichTextView document={asRichTextDocument(value)} />
          </div>
          <FieldErrors errors={errors} id={errorId} />
          <FieldHelp help={field.help} id={helpId} />
        </fieldset>
      );
    }

    case "image": {
      const image = asRecord(value);
      return (
        <fieldset
          className="cms-field"
          data-field
          data-field-kind="image"
          data-field-name={field.name}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">{labelOverride}</span>
          ) : (
            <legend className="cms-field-label">
              <FieldLabelText field={field} />
            </legend>
          )}
          <FieldHelp help={field.help} id={helpId} />
          {media && media.length > 0 && (
            <>
              <SubControlLabel htmlFor={idFor("pick")}>
                Reuse an upload
              </SubControlLabel>
              <select
                id={idFor("pick")}
                data-image-picker
                aria-label={controlId ? undefined : "Reuse an upload"}
              >
                <option value="" selected={!image.mediaId}>
                  Choose an image…
                </option>
                {/* Only the current image, so a picker in a long page is cheap;
                    the client fills the rest from the form's one options
                    template when the picker is first focused. The label falls
                    back to the id when the stored alt override is empty. */}
                {image.mediaId && (
                  <option value={asString(image.mediaId)} selected>
                    {asString(image.alt) || asString(image.mediaId)}
                  </option>
                )}
              </select>
              <span className="cms-field-help">
                Only the newest 50 uploads are listed. To reuse an older one,
                find its id on the Media page.
              </span>
            </>
          )}
          <SubControlLabel htmlFor={idFor("id")}>Media id</SubControlLabel>
          <input
            type="text"
            id={idFor("id")}
            data-image-id
            placeholder="Media id"
            aria-label={controlId ? undefined : "Media id"}
            value={asString(image.mediaId)}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={described}
          />
          <SubControlLabel htmlFor={idFor("alt")}>Alt text</SubControlLabel>
          <input
            type="text"
            id={idFor("alt")}
            data-image-alt
            placeholder="Alt text"
            aria-label={controlId ? undefined : "Alt text"}
            value={asString(image.alt)}
          />
          <FieldErrors errors={errors} id={errorId} />
          {field.image?.minWidth && (
            <span className="cms-field-help">
              Needs at least {field.image.minWidth}px wide
            </span>
          )}
        </fieldset>
      );
    }

    case "link": {
      const link = asRecord(value);
      const type = link.type === "page" ? "page" : "url";
      return (
        <fieldset
          className="cms-field cms-field-link"
          data-field
          data-field-kind="link"
          data-field-name={field.name}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">{labelOverride}</span>
          ) : (
            <legend className="cms-field-label">
              <FieldLabelText field={field} />
            </legend>
          )}
          <FieldHelp help={field.help} id={helpId} />
          <SubControlLabel htmlFor={idFor("type")}>Link type</SubControlLabel>
          <select
            id={idFor("type")}
            data-link-type
            aria-label={controlId ? undefined : "Link type"}
          >
            <option value="url" selected={type === "url"}>
              External URL
            </option>
            <option value="page" selected={type === "page"}>
              CMS page
            </option>
          </select>
          <div className="cms-link-url">
            <SubControlLabel htmlFor={idFor("url")}>
              External URL
            </SubControlLabel>
            <input
              type="text"
              id={idFor("url")}
              data-link-url
              placeholder="https://…"
              aria-label={controlId ? undefined : "External URL"}
              value={asString(link.url)}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={described}
            />
          </div>
          <div className="cms-link-page">
            <SubControlLabel htmlFor={idFor("page")}>CMS page</SubControlLabel>
            <select
              id={idFor("page")}
              data-link-page
              aria-label={controlId ? undefined : "CMS page"}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={described}
            >
              <option value="" selected={!link.pageId}>
                Choose a page…
              </option>
              {/* The link stores the page id, so a rename changes what this
                  resolves to without touching the saved content. */}
              {(pages ?? []).map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  selected={option.id === link.pageId}
                >
                  {option.title} ({option.url})
                </option>
              ))}
            </select>
          </div>
          <SubControlLabel htmlFor={idFor("label")}>Label</SubControlLabel>
          <input
            type="text"
            id={idFor("label")}
            data-link-label
            placeholder="Label"
            aria-label={controlId ? undefined : "Label"}
            value={asString(link.label)}
          />
          <label className="cms-field-checkbox">
            <input
              type="checkbox"
              id={idFor("newtab")}
              data-link-newtab
              checked={link.newTab === true}
            />
            Open in a new tab
          </label>
          <FieldErrors errors={errors} id={errorId} />
        </fieldset>
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
            <span className="cms-field-label">{fieldName(field)}</span>
            <span className="cms-field-help">
              This list has no item metadata published; it can't be edited.
            </span>
          </div>
        );
      }

      // "Up to N items" sits in the field's own help line, so there is one help
      // element per control (the id `aria-describedby` points at).
      const help = listHelp(field);
      // An empty list still renders one row, so a required list has somewhere
      // to type before the editor adds a second entry.
      const rows = items.length > 0 ? items : [undefined];
      // A row is cloned, so it has no stable number to name itself with; the
      // list's own label is what makes each row's Add and Remove say which
      // list they belong to.
      const listLabel = fieldName(field);
      const atMax = field.max !== undefined && items.length >= field.max;

      return (
        <fieldset
          className="cms-field"
          data-field
          data-field-kind="list"
          data-field-name={field.name}
          data-list
          data-max={field.max}
          data-min={field.min}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">{labelOverride}</span>
          ) : (
            <legend className="cms-field-label">
              <FieldLabelText field={field} />
            </legend>
          )}
          <div data-list-items>
            {rows.map((item, index) => (
              <ListItemControl
                key={index}
                field={itemField}
                value={item}
                listLabel={listLabel}
                pages={pages}
                media={media}
              />
            ))}
          </div>
          {/* Cloned by the editor when an item is added. Never in the form's
              query scope, so it is not serialised with the real rows. */}
          <template data-list-template>
            <ListItemControl
              field={itemField}
              value={undefined}
              listLabel={listLabel}
              pages={pages}
              media={media}
            />
          </template>
          <button
            type="button"
            className="cms-list-add"
            data-list-add
            aria-disabled={atMax ? "true" : undefined}
            aria-describedby={help ? helpId : undefined}
            aria-label={`Add to ${listLabel}`}
          >
            Add item
          </button>
          <FieldErrors errors={errors} id={errorId} />
          <FieldHelp help={help} id={helpId} />
        </fieldset>
      );
    }
  }
};
