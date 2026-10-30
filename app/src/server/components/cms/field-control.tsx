import {
  type FieldMetadata,
  MAX_ALT_LENGTH,
} from "@alexpricedev/billet-cms/contract";
import type { RichTextDocument } from "@alexpricedev/billet-cms/fields";
import type { ComponentChildren, JSX } from "preact";
import type { PageOption } from "../../services/content/pages";
import type { MediaOption } from "../../services/media";
import { MEDIA_PICKER_LIMIT } from "../../services/media/limits";
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

/** Last-resort scope for a link with no id or row name; see `radioName`. */
let unscopedLink = 0;

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
  /**
   * Where a control sits in the tree, for the few things that need to differ
   * between two copies even when ids can't: a radio group's `name` has to be
   * unique per link, or picking a type in one list row unchecks it in the next.
   */
  nameScope?: string;
  /**
   * Whether this control is a direct child of a `group`.
   *
   * A group heading owns the group's one required marker, so a child never
   * repeats it: two asterisks stacked over one column read as two labels for
   * the same thing. The child is still `aria-required`; only the visible
   * marker is the group's to show.
   */
  inGroup?: boolean;
  /** The CMS pages a `link` field may point at, for the internal-link picker. */
  pages?: PageOption[];
  /**
   * Whether the form offers a reuse picker at all. The options themselves are
   * rendered once per form by `MediaOptionsTemplate`; this only says whether a
   * picker is worth showing, so an empty library renders none.
   */
  hasMedia: boolean;
  /**
   * Whether that reuse list was actually capped (the library held more than
   * `MEDIA_PICKER_LIMIT`). The help line pointing at the id field is only true
   * then; at exactly the cap nothing is older to go looking for.
   */
  pickerCapped: boolean;
  /**
   * The uploads the picker offers, for the one thing a field needs from them:
   * the chosen image's own label and width. The options themselves are rendered
   * once per form by `MediaOptionsTemplate`.
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
  media: MediaOption[];
}): JSX.Element | null =>
  media && media.length > 0 ? (
    <template data-media-options>
      {media.map((option) => (
        <option
          key={option.id}
          value={option.id}
          data-media-width={option.width}
        >
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

const FieldLabelText = ({
  field,
  inGroup = false,
}: {
  field: FieldMetadata;
  inGroup?: boolean;
}): JSX.Element => (
  <>
    {fieldName(field)}
    {!inGroup && field.required && <span className="cms-required"> *</span>}
  </>
);

/**
 * A group heading: the container's title, never a second label.
 *
 * A group owns exactly one required marker, and it sits here. A required group
 * carries the asterisk; an optional one says "Optional" beside its name, and
 * its parts carry no marker of their own — inside a group they are required (or
 * not) by the group's own state, so a second asterisk would read as a second
 * label for the same control.
 *
 * An optional link is optional only while it is empty: once the editor starts
 * filling it in, it has become a link that must be complete, so the asterisk
 * takes the place of "Optional". Both are rendered and the stylesheet swaps
 * them, because "in use" is what CSS reads from the inputs themselves.
 *
 * `text` is the field's own name, or the list's name when the row overrides it.
 * The marker belongs to the control, not the word, so an overridden heading
 * carries it too — otherwise a required link in a list row has no marker
 * anywhere, since its sub-labels never render one.
 */
const HeadingText = ({
  text,
  field,
  inGroup = false,
}: {
  text: string;
  field: FieldMetadata;
  inGroup?: boolean;
}): JSX.Element => {
  if (inGroup) return <>{text}</>;
  if (field.required) {
    return (
      <>
        {text}
        <span className="cms-required"> *</span>
      </>
    );
  }
  return (
    <>
      {text}
      {field.kind === "link" && <span className="cms-required"> *</span>}
      <span className="cms-field-optional"> Optional</span>
    </>
  );
};

const GroupLabelText = ({
  field,
  inGroup = false,
}: {
  field: FieldMetadata;
  inGroup?: boolean;
}): JSX.Element => (
  <HeadingText text={fieldName(field)} field={field} inGroup={inGroup} />
);

const FieldHelp = ({
  help,
  id,
  className,
}: {
  help?: string;
  id?: string;
  className?: string;
}): JSX.Element | null =>
  help ? (
    <span
      className={className ? `cms-field-help ${className}` : "cms-field-help"}
      id={id}
    >
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

/** The four destinations a link field offers, in the switch's order. */
const LINK_TYPES = ["url", "page", "email", "phone"] as const;
type LinkType = (typeof LINK_TYPES)[number];

const LINK_TYPE_LABELS: Record<LinkType, string> = {
  url: "URL",
  page: "Page",
  email: "Email",
  phone: "Phone",
};

/**
 * The paths each kind draws inside the shared 14px line icon.
 *
 * The four share every svg attribute, so only the shapes differ; `url` is the
 * globe, `page` a document, `email` an envelope and `phone` a handset.
 */
const LINK_TYPE_PATHS: Record<LinkType, JSX.Element> = {
  url: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c1.5 1.6 2.3 3.4 2.3 5.5S9.5 11.9 8 13.5C6.5 11.9 5.7 10.1 5.7 8S6.5 4.1 8 2.5Z" />
    </>
  ),
  page: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  email: (
    <>
      <rect x="2" y="4" width="12" height="8" rx="1" />
      <path d="m2.5 4.5 5.5 4 5.5-4" />
    </>
  ),
  phone: (
    <path d="M5.5 2.5c.4 0 .7.2.9.6l.7 1.5c.2.4.1.8-.2 1.1l-.8.7a8 8 0 0 0 3.3 3.3l.7-.8c.3-.3.7-.4 1.1-.2l1.5.7c.4.2.6.5.6.9v1.4c0 .6-.5 1.1-1.1 1.1A10.4 10.4 0 0 1 2.5 3.6c0-.6.5-1.1 1.1-1.1h1.9Z" />
  ),
};

/**
 * The 14px line icons on the type switch and inside the destination input.
 *
 * Decorative: the switch option's own text names it, and the input has a
 * visually hidden label, so every icon is `aria-hidden`.
 */
const LinkTypeIcon = ({ kind }: { kind: LinkType }): JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {LINK_TYPE_PATHS[kind]}
  </svg>
);

/**
 * One destination wrapper: the visually hidden label, its type icon, the
 * control, and the error list when this is the selected type and it has one.
 *
 * Four destinations share this markup, so the wiring lives here rather than
 * being repeated per control; `active` is what decides whether the error list
 * is rendered under a destination the editor can currently see.
 */
const LinkDestination = ({
  kind,
  label,
  htmlFor,
  active,
  errors,
  errorId,
  children,
}: {
  kind: LinkType;
  label: string;
  htmlFor?: string;
  active: boolean;
  errors: FieldError[];
  errorId?: string;
  children: JSX.Element;
}): JSX.Element => (
  <div className="cms-link-destination" data-link-destination={kind}>
    <label className="sr-only" htmlFor={htmlFor}>
      {label}
    </label>
    <span className="cms-link-icon" aria-hidden="true">
      <LinkTypeIcon kind={kind} />
    </span>
    {children}
    {active && <FieldErrors errors={errors} id={errorId} />}
  </div>
);

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
  nameScope,
  pages,
  hasMedia,
  pickerCapped,
  media,
}: {
  field: FieldMetadata;
  value: unknown;
  /** The list's own label, so every Add/Remove names the list it belongs to. */
  listLabel: string;
  /** Where the row sits, so a link in it gets radio names of its own. */
  nameScope: string;
  pages?: PageOption[];
  hasMedia: boolean;
  pickerCapped: boolean;
  media?: MediaOption[];
}): JSX.Element => (
  <div className="cms-list-item" data-list-item>
    <FieldControl
      field={field}
      value={value}
      labelOverride={listLabel}
      nameScope={nameScope}
      pages={pages}
      hasMedia={hasMedia}
      pickerCapped={pickerCapped}
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
  nameScope,
  inGroup = false,
  pages,
  hasMedia,
  pickerCapped,
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
  // Only ids that render: FieldHelp needs `field.help`, FieldErrors needs errors.
  const described = describedBy(
    field.help ? helpId : undefined,
    invalid ? errorId : undefined,
  );
  const countId = idFor("count");

  switch (field.kind) {
    case "text": {
      // A field that allows more than a long line is still one plain string, so
      // the control is picked from `max` alone — there is no field option. A
      // three-row textarea (the client grows it as the editor types) gives them
      // room to see the words; at 120 or under, an input keeps its one line.
      const multiline = field.max !== undefined && field.max > 120;
      const textDescribedBy =
        field.max === undefined ? described : describedBy(described, countId);
      const label = labelOverride ? (
        <span className="cms-field-label">{labelOverride}</span>
      ) : (
        <label className="cms-field-label" htmlFor={controlId}>
          <FieldLabelText field={field} inGroup={inGroup} />
        </label>
      );
      return (
        <div
          className="cms-field"
          data-field
          data-field-kind="text"
          data-field-name={field.name}
        >
          {/* The counter shares the label's row instead of taking one of its
              own under the box, where the empty space above it read as a wider
              gap to the next field. It keeps its id and live region, so
              `aria-describedby` and `cms-form.ts` are unchanged. Only a field
              with a counter gets the flex row: without one the label stays a
              direct grid child, so it spans the row and the whole line focuses
              the control. */}
          {field.max === undefined ? (
            label
          ) : (
            <div className="cms-field-label-row">
              {label}
              <p
                className="cms-field-help cms-char-count"
                id={countId}
                aria-live="polite"
                data-char-count
                data-char-max={field.max}
              >
                {asString(value).length} / {field.max}
              </p>
            </div>
          )}
          {multiline ? (
            <textarea
              id={controlId}
              data-text-input
              rows={3}
              aria-label={labelOverride}
              aria-required={required ? "true" : undefined}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={textDescribedBy}
            >
              {asString(value)}
            </textarea>
          ) : (
            <input
              type="text"
              id={controlId}
              data-text-input
              value={asString(value)}
              aria-label={labelOverride}
              aria-required={required ? "true" : undefined}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={textDescribedBy}
            />
          )}
          {field.max !== undefined && !invalid && (
            <p className="cms-field-errors" data-char-over hidden>
              Use {field.max} characters or fewer.
            </p>
          )}
          <FieldErrors errors={errors} id={errorId} />
          <FieldHelp help={field.help} id={helpId} />
        </div>
      );
    }

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
              <FieldLabelText field={field} inGroup={inGroup} />
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
      const mediaId = asString(image.mediaId);
      // The picks the form already knows about, so a current image is labelled
      // with its own alt and dimensions rather than a bare "Current image". The
      // media list includes every image the content references (see
      // `listPickerMedia`), so the common case is found; a deleted or unlisted
      // id falls back to the old label rather than showing a raw id.
      const current = mediaId
        ? media?.find((option) => option.id === mediaId)
        : undefined;
      const currentLabel = current
        ? `${current.alt} (${current.width}×${current.height})`
        : "Current image";
      return (
        <fieldset
          className="cms-field"
          data-field
          data-field-kind="image"
          data-field-name={field.name}
          data-image-min-width={field.image?.minWidth}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">{labelOverride}</span>
          ) : (
            <legend className="cms-field-label">
              <FieldLabelText field={field} inGroup={inGroup} />
            </legend>
          )}
          {/* A fieldset's legend is outside its grid, so the field's 6px gap
              does not sit between the heading and a help line. The class puts
              that gap back; a list row's span label is a grid item and must not
              get it twice. */}
          <FieldHelp
            help={field.help}
            id={helpId}
            className={labelOverride ? undefined : "cms-image-help"}
          />
          {/* The three sub-parts are spaced like separate fields; each keeps
              the label-to-control rhythm of one. The wrapper is also where the
              heading's extra air comes from (see the image rules in cms.css):
              `after-label` subtracts the 6px a span label's grid gap already
              contributes, and `after-help` lets the help line keep the 6px. */}
          <div
            className={`cms-image-parts${
              labelOverride ? " cms-image-parts-after-label" : ""
            }${field.help ? " cms-image-parts-after-help" : ""}`}
          >
            {hasMedia && (
              <div className="cms-image-part">
                <SubControlLabel htmlFor={idFor("pick")}>
                  Reuse an upload
                </SubControlLabel>
                <select
                  id={idFor("pick")}
                  data-image-picker
                  aria-label={controlId ? undefined : "Reuse an upload"}
                  aria-describedby={
                    pickerCapped ? idFor("pick-help") : undefined
                  }
                >
                  <option value="" selected={!image.mediaId}>
                    Choose an image…
                  </option>
                  {/* Only the current image, so a picker in a long page is
                      cheap; the client fills the rest from the form's one
                      options template when the picker is first focused,
                      relabelling this option when the current image is one of
                      them unless it carries a per-use alt the editor typed. Its
                      label is the upload's own alt and dimensions when the
                      field knows them (part 10: it used to say only "Current
                      image"), and falls back to that phrase for a deleted or
                      unlisted id so a raw id is never shown as a label. */}
                  {image.mediaId && (
                    <option
                      value={mediaId}
                      selected
                      data-media-keep-label={
                        asString(image.alt) ? "" : undefined
                      }
                      data-media-width={current?.width}
                    >
                      {asString(image.alt) || currentLabel}
                    </option>
                  )}
                </select>
                {/* Only when the reuse list was actually capped: a library of
                    the cap or fewer lists everything, so there is nothing older
                    to go looking for. */}
                {pickerCapped && (
                  <span className="cms-field-help" id={idFor("pick-help")}>
                    Showing the newest {MEDIA_PICKER_LIMIT} uploads. For an
                    older one, paste its id under Media id.
                  </span>
                )}
              </div>
            )}
            <div className="cms-image-part">
              <SubControlLabel htmlFor={idFor("id")}>Media id</SubControlLabel>
              <input
                type="text"
                id={idFor("id")}
                data-image-id
                aria-label={controlId ? undefined : "Media id"}
                value={asString(image.mediaId)}
                aria-invalid={invalid ? "true" : undefined}
                aria-describedby={described}
              />
            </div>
            <div className="cms-image-part">
              <SubControlLabel htmlFor={idFor("alt")}>Alt text</SubControlLabel>
              <input
                type="text"
                id={idFor("alt")}
                data-image-alt
                aria-label={controlId ? undefined : "Alt text"}
                value={asString(image.alt)}
                maxLength={MAX_ALT_LENGTH}
                aria-describedby={idFor("alt-help")}
              />
              <span className="cms-field-help" id={idFor("alt-help")}>
                Optional. Leave blank to use the upload's own alt text. Up to{" "}
                {MAX_ALT_LENGTH} characters.
              </span>
            </div>
          </div>
          <FieldErrors errors={errors} id={errorId} />
          {field.image?.minWidth && (
            <span className="cms-field-help">
              Needs at least {field.image.minWidth}px wide
            </span>
          )}
          {/* A too-narrow image is a warning, not a refusal (part 10), so the
              server has no field error to put here. `cms-form.ts` fills it when
              the picker changes, from the chosen option's `data-media-width` and
              this fieldset's `data-image-min-width` — two numbers the server
              already rendered, so nothing is built from data. After a save the
              notice above the form carries the same warning. */}
          <p
            className="cms-field-warning"
            role="status"
            data-image-warning
            hidden
          />
        </fieldset>
      );
    }

    case "link": {
      const link = asRecord(value);
      // Email and Phone have no stored type of their own: both are url-mode
      // links whose scheme is what the editor recognises them by.
      const storedUrl = asString(link.url);
      const lowerUrl = storedUrl.toLowerCase();
      const type: LinkType =
        link.type === "page"
          ? "page"
          : lowerUrl.startsWith("mailto:")
            ? "email"
            : lowerUrl.startsWith("tel:")
              ? "phone"
              : "url";

      // Errors arrive with the whole dotted path (`cta.url`), so each control
      // takes the message whose last segment names it. Anything else — a
      // whole-link issue, or a field-level one the schema produced — stays on
      // the container.
      const forControl = (segment: string): FieldError[] =>
        (errors ?? []).filter(
          (error) =>
            error.path.slice(error.path.lastIndexOf(".") + 1) === segment,
        );
      const labelErrors = forControl("label");
      const titleErrors = forControl("title");
      // Only the selected type's destination is rendered with an error list, so
      // only its key counts as "known". An error on the other one — a `pageId`
      // failure on a url-rendered link, say — has no visible control of its own
      // and falls through to the container rather than disappearing.
      const activeDestination = type === "page" ? "pageId" : "url";
      const destinationErrors = forControl(activeDestination);
      const known = new Set(["label", "title", activeDestination]);
      const groupErrors = (errors ?? []).filter(
        (error) =>
          !known.has(error.path.slice(error.path.lastIndexOf(".") + 1)),
      );

      const labelErrorId = idFor("label-error");
      const titleErrorId = idFor("title-error");
      const destinationErrorId = idFor("destination-error");
      const titleHelpId = idFor("title-help");
      // Radio `name` groups the four options into one control. A row has no
      // stable id, so the list hands it a `nameScope` that differs per row —
      // share the name and picking a type in one row unchecks it in the next.
      // If neither is there (a control rendered outside `ContentFields`, as a
      // test or a future caller might), a counter still keeps two same-named
      // links from becoming one browser-side group; the page is rendered once,
      // so a process-local counter is enough.
      const radioName = `${
        nameScope ?? controlId ?? `cms-link-${++unscopedLink}`
      }-type`;
      const destinationAria = (kind: LinkType) =>
        type === kind && destinationErrors.length > 0
          ? {
              "aria-invalid": "true" as const,
              "aria-describedby": destinationErrorId,
            }
          : {};

      return (
        <fieldset
          className={`cms-field cms-field-link${
            required ? "" : " cms-field-link-optional"
          }`}
          data-field
          data-field-kind="link"
          data-field-name={field.name}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">
              <HeadingText
                text={labelOverride}
                field={field}
                inGroup={inGroup}
              />
            </span>
          ) : (
            <legend className="cms-field-label">
              <GroupLabelText field={field} inGroup={inGroup} />
            </legend>
          )}
          <FieldHelp help={field.help} id={helpId} />

          <div className="cms-link-text">
            <SubControlLabel htmlFor={idFor("label")}>
              Button text
            </SubControlLabel>
            {/* A blank placeholder is what lets the optional-link rule swap
                "Optional" for the heading's asterisk once the box is in use:
                CSS reads `:placeholder-shown` on the group's inputs, and an
                input with no placeholder attribute never matches it. */}
            <input
              type="text"
              id={idFor("label")}
              data-link-label
              placeholder=" "
              aria-label={controlId ? undefined : "Button text"}
              value={asString(link.label)}
              aria-invalid={labelErrors.length > 0 ? "true" : undefined}
              aria-describedby={
                labelErrors.length > 0 ? labelErrorId : undefined
              }
            />
            <FieldErrors errors={labelErrors} id={labelErrorId} />
          </div>

          <div className="cms-link-destination-group">
            <span className="cms-field-sublabel">Goes to</span>
            <div
              className="cms-link-types"
              role="radiogroup"
              aria-label="Link type"
            >
              {LINK_TYPES.map((kind) => (
                <label key={kind} className="cms-link-type">
                  <input
                    type="radio"
                    className="sr-only"
                    name={radioName}
                    value={kind}
                    data-link-type
                    checked={type === kind}
                  />
                  <LinkTypeIcon kind={kind} />
                  <span>{LINK_TYPE_LABELS[kind]}</span>
                </label>
              ))}
            </div>

            <LinkDestination
              kind="url"
              label="URL"
              htmlFor={idFor("url")}
              active={type === "url"}
              errors={destinationErrors}
              errorId={destinationErrorId}
            >
              {/* `type="text"`: the stored value may be a root-relative path
                  or a fragment (`/pricing`, `#faq`), which the browser's
                  `type="url"` validation would refuse before the server saw
                  it. `inputMode` still asks for a URL keyboard. */}
              <input
                type="text"
                inputMode="url"
                id={idFor("url")}
                data-link-url
                placeholder="https://…"
                aria-label={controlId ? undefined : "URL"}
                value={type === "url" ? storedUrl : ""}
                {...destinationAria("url")}
              />
            </LinkDestination>

            <LinkDestination
              kind="page"
              label="Page"
              htmlFor={idFor("page")}
              active={type === "page"}
              errors={destinationErrors}
              errorId={destinationErrorId}
            >
              <select
                id={idFor("page")}
                data-link-page
                aria-label={controlId ? undefined : "Page"}
                {...destinationAria("page")}
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
            </LinkDestination>

            <LinkDestination
              kind="email"
              label="Email"
              htmlFor={idFor("email")}
              active={type === "email"}
              errors={destinationErrors}
              errorId={destinationErrorId}
            >
              <input
                type="email"
                id={idFor("email")}
                data-link-email
                placeholder="name@example.com"
                aria-label={controlId ? undefined : "Email"}
                value={
                  type === "email" ? storedUrl.slice("mailto:".length) : ""
                }
                {...destinationAria("email")}
              />
            </LinkDestination>

            <LinkDestination
              kind="phone"
              label="Phone"
              htmlFor={idFor("phone")}
              active={type === "phone"}
              errors={destinationErrors}
              errorId={destinationErrorId}
            >
              <input
                type="tel"
                id={idFor("phone")}
                data-link-phone
                placeholder="+44 20 7946 0000"
                aria-label={controlId ? undefined : "Phone"}
                value={type === "phone" ? storedUrl.slice("tel:".length) : ""}
                {...destinationAria("phone")}
              />
            </LinkDestination>

            <label className="cms-link-newtab" data-link-newtab-row>
              <input
                type="checkbox"
                id={idFor("newtab")}
                data-link-newtab
                checked={link.newTab === true}
              />
              Open in a new tab
            </label>
          </div>

          <hr className="cms-link-divider" />

          <div className="cms-link-title">
            <SubControlLabel htmlFor={idFor("title")}>
              Hover text
              <span className="cms-field-optional"> Optional</span>
            </SubControlLabel>
            <input
              type="text"
              id={idFor("title")}
              data-link-title
              placeholder=" "
              aria-label={controlId ? undefined : "Hover text"}
              value={asString(link.title)}
              aria-invalid={titleErrors.length > 0 ? "true" : undefined}
              aria-describedby={titleHelpId}
            />
            <span className="cms-field-help" id={titleHelpId}>
              Shown as a tooltip when someone hovers over the link.
            </span>
            <FieldErrors errors={titleErrors} id={titleErrorId} />
          </div>

          <FieldErrors errors={groupErrors} id={errorId} />
        </fieldset>
      );
    }

    case "group": {
      const children = field.fields ?? [];
      if (children.length === 0) {
        return (
          <div
            className="cms-field"
            data-field
            data-field-kind="group"
            data-field-name={field.name}
          >
            <span className="cms-field-label">{fieldName(field)}</span>
            <span className="cms-field-help">
              This group has no field metadata published; it can't be edited.
            </span>
          </div>
        );
      }

      const record = asRecord(value);

      return (
        <fieldset
          className="cms-field cms-field-group"
          data-field
          data-field-kind="group"
          data-field-name={field.name}
          id={controlId}
          aria-label={labelOverride}
        >
          {labelOverride ? (
            <span className="cms-field-label">
              <HeadingText
                text={labelOverride}
                field={field}
                inGroup={inGroup}
              />
            </span>
          ) : (
            <legend className="cms-field-label">
              <GroupLabelText field={field} inGroup={inGroup} />
            </legend>
          )}
          {/* Scoped, so the client reads these as the group's own fields and
              not a second time as the form's. */}
          <div data-group-fields>
            {children.map((child) => (
              <FieldControl
                key={child.name}
                field={child}
                value={record?.[child.name]}
                // A group in a list row has no id to hang a <label for> on, so
                // its children name themselves with their own label rather
                // than inheriting the row's — "Title", not "Steps".
                idBase={controlId ? `${controlId}-${child.name}` : undefined}
                labelOverride={controlId ? undefined : fieldName(child)}
                inGroup
                nameScope={
                  nameScope
                    ? `${nameScope}-${child.name}`
                    : controlId
                      ? `${controlId}-${child.name}`
                      : undefined
                }
                pages={pages}
                hasMedia={hasMedia}
                pickerCapped={pickerCapped}
                media={media}
              />
            ))}
          </div>
          <FieldErrors errors={errors} id={errorId} />
          <FieldHelp help={field.help} id={helpId} />
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
      // Each row gets a scope of its own. The template's is distinct from every
      // real row's, and the client re-names a clone the moment it is added.
      const scopeBase = nameScope ?? controlId ?? field.name;
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
              <FieldLabelText field={field} inGroup={inGroup} />
            </legend>
          )}
          <div data-list-items>
            {rows.map((item, index) => (
              <ListItemControl
                key={index}
                field={itemField}
                value={item}
                listLabel={listLabel}
                nameScope={`${scopeBase}-${itemField.name}-${index}`}
                pages={pages}
                hasMedia={hasMedia}
                pickerCapped={pickerCapped}
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
              nameScope={`${scopeBase}-${itemField.name}-template`}
              pages={pages}
              hasMedia={hasMedia}
              pickerCapped={pickerCapped}
              media={media}
            />
          </template>
          <button
            type="button"
            className="cms-list-add"
            data-list-add
            aria-disabled={atMax ? "true" : undefined}
            aria-describedby={help ? helpId : undefined}
            aria-label={`Add item to ${listLabel}`}
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
