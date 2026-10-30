import type { JSX } from "preact";
import type { FieldError } from "./field-control";

/**
 * One upload, as the picker's closed field shows it.
 *
 * The server renders the current image from the media service, and the client
 * uses the same shape for a pick or an upload, so the closed field is drawn
 * once from data rather than being built twice.
 */
export interface PickerImage {
  id: string;
  alt: string;
  width: number;
  height: number;
  /** Null when the upload has no rendition the picker can show. */
  thumbnailUrl: string | null;
}

export interface ImagePickerProps {
  /** The form field name; the hidden input carries the chosen media id. */
  name: string;
  label: string;
  help?: string;
  /** The currently chosen media id, or null/empty for none. */
  value: string | null;
  /** The chosen upload, when the server could read it. */
  image?: PickerImage | null;
  errors?: FieldError[];
  /**
   * A CSRF token minted for `POST /cms/media`. The page's save token is bound
   * to the page path and cannot authorize an upload; the drop zone sends this
   * one as the `X-CSRF-Token` header.
   */
  uploadCsrfToken: string;
}

const idBase = (name: string): string => `cms-image-picker-${name}`;

/**
 * The shared image picker: a server-rendered closed field plus the dialog and
 * drop zone `client/image-picker.ts` brings to life.
 *
 * The component knows nothing about page settings — a field name, a media id
 * and labels are all it takes — so the follow-on ticket can use it for block
 * `image` fields unchanged.
 *
 * With JavaScript off, the closed field and the hidden input still render and
 * submit the stored id unchanged; only Choose image, Remove, the grid and the
 * drop zone need the script. The client module builds the dialog's tiles from
 * the options route and the upload's JSON answer; this component never renders
 * an image the library did not give it, so a missing thumbnail is a
 * placeholder rather than a broken `<img>`.
 */
export const ImagePicker = ({
  name,
  label,
  help,
  value,
  image,
  errors,
  uploadCsrfToken,
}: ImagePickerProps): JSX.Element => {
  const base = idBase(name);
  const labelId = `${base}-label`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  const dialogTitleId = `${base}-title`;
  const invalid = errors !== undefined && errors.length > 0;
  const described = [help ? helpId : null, invalid ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const chosen = value !== null && value !== "";

  // The thumbnail is only rendered when there is one. An upload with no usable
  // rendition gets the token-coloured placeholder carrying its alt text, which
  // is also what the client swaps in — never an `<img>` with an empty `src`.
  const thumbnail = image?.thumbnailUrl ?? null;

  return (
    <fieldset
      className="cms-field cms-image-picker"
      data-image-picker-field
      data-image-picker-csrf={uploadCsrfToken}
      data-image-picker-name={name}
      aria-describedby={described || undefined}
      aria-invalid={invalid ? "true" : undefined}
    >
      <legend className="cms-field-label" id={labelId}>
        {label}
      </legend>
      <input
        type="hidden"
        name={name}
        value={chosen ? value : ""}
        data-image-picker-value
      />

      <div className="cms-image-picker-current" data-image-picker-current>
        {thumbnail ? (
          <img
            className="cms-image-picker-thumb"
            data-image-picker-thumb
            src={thumbnail}
            alt=""
            loading="lazy"
          />
        ) : (
          <img
            className="cms-image-picker-thumb"
            data-image-picker-thumb
            alt=""
            hidden
          />
        )}
        <span
          className="cms-image-picker-thumb cms-image-picker-placeholder"
          data-image-picker-thumb-placeholder
          aria-hidden="true"
          hidden={thumbnail !== null}
        >
          {image ? image.alt : "No image"}
        </span>
        <span className="cms-image-picker-details">
          <span className="cms-image-picker-alt" data-image-picker-alt>
            {image ? image.alt : "No image chosen."}
          </span>
          <span className="cms-image-picker-size" data-image-picker-size>
            {image ? `${image.width}×${image.height}` : ""}
          </span>
        </span>
      </div>

      <div className="cms-image-picker-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-image-picker-choose
        >
          Choose image
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-image-picker-remove
          hidden={!chosen}
        >
          Remove
        </button>
      </div>

      {invalid && (
        <ul className="cms-field-errors" id={errorId}>
          {errors?.map((error, index) => (
            <li key={`${error.path}:${index}`}>{error.message}</li>
          ))}
        </ul>
      )}
      {help && (
        <span className="cms-field-help" id={helpId}>
          {help}
        </span>
      )}

      {/* The dialog is in the document from the start and hidden, so opening
          it moves no layout and the file input exists before any script runs. */}
      <div className="cms-picker-overlay" data-image-picker-modal hidden>
        <div
          className="cms-picker-dialog"
          data-picker-dialog
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
        >
          <div className="cms-picker-header">
            <h2 id={dialogTitleId}>Choose an image</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-image-picker-close
            >
              Close
            </button>
          </div>

          <div className="cms-picker-drop" data-image-picker-drop>
            <p className="cms-picker-drop-text">
              Drop images here, or choose a file.
            </p>
            <label className="btn btn-secondary btn-sm cms-picker-file">
              Choose file
              <input
                type="file"
                className="sr-only"
                accept="image/jpeg,image/png,image/webp"
                multiple
                data-image-picker-file
              />
            </label>
            <p className="cms-field-help">
              JPEG, PNG or WebP up to 20 MB. A dropped image uses its file name
              as alt text; edit it on the media page afterwards.
            </p>
          </div>

          {/* Upload tiles are added per file; the client builds them with
              createElement and textContent, never innerHTML. */}
          <ul className="cms-picker-uploads" data-image-picker-uploads />

          <div className="cms-picker-toolbar">
            <input
              type="search"
              className="cms-picker-search"
              placeholder="Search by alt text"
              aria-label="Search images by alt text"
              data-image-picker-search
            />
          </div>

          <ul
            className="cms-picker-grid"
            data-image-picker-grid
            aria-label="Images"
          />

          <p
            className="cms-picker-status"
            role="status"
            data-image-picker-status
          />

          <div className="cms-picker-footer">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-image-picker-more
              hidden
            >
              Load more
            </button>
          </div>
        </div>
      </div>
    </fieldset>
  );
};
