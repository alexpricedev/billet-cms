import type { MediaVariant } from "@alexpricedev/billet-cms/contract";
import { Layout } from "../../components/layouts";
import { getAssetUrl } from "../../services/assets";
import {
  MAX_ALT_LENGTH,
  type MediaIssue,
  type MediaRecord,
  type MediaUsage,
} from "../../services/media";
import type { User } from "../../services/users";

export interface MediaListProps {
  user: User;
  /** The CSRF token bound to the upload POST. */
  csrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  items: MediaRecord[];
  notice?: string | null;
  errors?: MediaIssue[];
  /** What the editor typed before a failed upload, so it isn't discarded. */
  values?: { alt: string };
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The smallest rendition at least twice `displayWidth` pixels wide.
 *
 * A thumbnail or preview is a fraction of the full-size original, so handing it
 * the largest rendition wastes the bucket's bandwidth on every card. The 2x
 * factor keeps it sharp on a high-density screen; when the source is smaller
 * than the target the largest rendition it has is used instead.
 *
 * `maxWidth` caps how wide the chosen rendition may be, for a surface that
 * doesn't need the full-size picture. The focal picker is the one that uses it:
 * it is a click target with a marker, so a 960px rendition is sharp enough and
 * the 1600/2400 ones are wasted bytes. Renditions above the cap are ignored
 * only when something at or below it exists, so a source that has none still
 * gets the smallest it does have rather than nothing.
 */
export const variantForDisplay = (
  media: MediaRecord,
  displayWidth: number,
  maxWidth?: number,
): MediaVariant | undefined => {
  const sorted = [...media.variants].sort((a, b) => a.width - b.width);
  const withinCap =
    maxWidth === undefined
      ? sorted
      : sorted.filter((variant) => variant.width <= maxWidth);
  const pool = withinCap.length > 0 ? withinCap : sorted;
  return (
    pool.find((variant) => variant.width >= displayWidth * 2) ??
    pool[pool.length - 1]
  );
};

/** The CSS display width in pixels of each surface, at a 16px root. */
const GRID_THUMBNAIL_WIDTH = 12 * 16;
const FOCAL_PICKER_WIDTH = 32 * 16;
// The picker is a click target, not a full-bleed image, so it stops at the 960
// rendition rather than pulling the 1600/2400 one the 2x rule would pick.
const FOCAL_PICKER_MAX_WIDTH = 960;
const FOCAL_PREVIEW_WIDTH = 10 * 16;
const DELETE_PREVIEW_WIDTH = 24 * 16;

/**
 * The uploads library: the reuse list, and the one upload form.
 *
 * The list is deliberately flat (no folders yet): every upload, newest first,
 * with a thumbnail, its alt text, its size and its dimensions. Clicking one
 * opens its detail, where the alt and the focal point are edited.
 */
export const MediaList = ({
  user,
  csrfToken,
  navCsrfToken,
  items,
  notice,
  errors,
  values,
}: MediaListProps) => (
  <Layout
    title="Media - Billet CMS"
    name="cms"
    description="Upload and reuse images."
    canonicalPath="/cms/media"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>Media</span>
    </p>
    <h1>Media</h1>
    <p className="cms-intro">
      Upload an image once and reuse it across the site. Alt text is required;
      JPEG, PNG and WebP up to 20 MB.
    </p>

    {notice && (
      <div className="flash-success" role="status">
        {notice}
      </div>
    )}

    {errors && errors.length > 0 && (
      <div className="flash-error" role="alert">
        <ul>
          {errors.map((error) => (
            <li key={`${error.field}:${error.message}`}>{error.message}</li>
          ))}
        </ul>
      </div>
    )}

    <form
      method="POST"
      action="/cms/media"
      encType="multipart/form-data"
      className="cms-media-upload"
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <div className="cms-field">
        <label className="cms-field-label" htmlFor="cms-media-file">
          Image file
        </label>
        <input
          type="file"
          id="cms-media-file"
          name="file"
          accept="image/jpeg,image/png,image/webp"
        />
      </div>
      <div className="cms-field">
        <label className="cms-field-label" htmlFor="cms-media-alt">
          Alt text <span className="cms-required">*</span>
        </label>
        <input
          type="text"
          id="cms-media-alt"
          name="alt"
          required
          maxLength={MAX_ALT_LENGTH}
          value={values?.alt ?? ""}
        />
      </div>
      <button type="submit" className="cms-save">
        Upload
      </button>
    </form>

    {items.length === 0 ? (
      <div className="flash-warning" role="status">
        No images yet. Upload one above to use it in an image field.
      </div>
    ) : (
      <ul className="cms-media-grid">
        {items.map((media) => (
          <li className="cms-media-card" key={media.id}>
            <a href={`/cms/media/${media.id}`}>
              <img
                src={
                  variantForDisplay(media, GRID_THUMBNAIL_WIDTH)?.fallbackUrl ??
                  ""
                }
                alt={media.alt}
                width={media.width}
                height={media.height}
                loading="lazy"
              />
            </a>
            <a className="cms-media-alt" href={`/cms/media/${media.id}`}>
              {media.alt}
            </a>
            <span className="cms-media-meta">
              {media.width}×{media.height} · {formatBytes(media.byteSize)} ·{" "}
              {media.contentType.replace("image/", "").toUpperCase()}
            </span>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);

export interface MediaDetailProps {
  user: User;
  /** The CSRF token bound to the save POST. */
  csrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  media: MediaRecord;
  /** The published pages and slots whose content references this image. */
  usage: MediaUsage[];
  /** A one-line outcome from a save or a refused delete. */
  notice?: { kind: "success" | "warning"; message: string } | null;
  errors?: MediaIssue[];
}

/**
 * One upload: the alt, the focal point, its uses, and delete.
 *
 * The focal point is a click on the picture. The previews below it show the
 * same crop at 16:9, 1:1 and 4:5 as the editor moves the marker; the hidden
 * `focal_x`/`focal_y` inputs are what the save posts, so with JavaScript off
 * the stored centre (or whatever was last saved) still round-trips.
 */
export const MediaDetail = ({
  user,
  csrfToken,
  navCsrfToken,
  media,
  usage,
  notice,
  errors,
}: MediaDetailProps) => {
  const pickerUrl =
    variantForDisplay(media, FOCAL_PICKER_WIDTH, FOCAL_PICKER_MAX_WIDTH)
      ?.fallbackUrl ?? "";
  const previewUrl =
    variantForDisplay(media, FOCAL_PREVIEW_WIDTH)?.fallbackUrl ?? "";
  const x = media.focalX * 100;
  const y = media.focalY * 100;
  const position = `object-position:${x}% ${y}%`;

  return (
    <Layout
      title={`${media.alt} - Media - Billet CMS`}
      name="cms"
      description="Edit an image's alt text and focal point."
      canonicalPath={`/cms/media/${media.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <p className="cms-breadcrumb">
        <a href="/cms">Content</a> / <a href="/cms/media">Media</a> /{" "}
        <span>{media.alt}</span>
      </p>
      <h1>Image</h1>

      {notice && (
        <div
          className={
            notice.kind === "success" ? "flash-success" : "flash-warning"
          }
          role="status"
        >
          {notice.message}
        </div>
      )}

      {errors && errors.length > 0 && (
        <div className="flash-error" role="alert">
          <ul>
            {errors.map((error) => (
              <li key={`${error.field}:${error.message}`}>{error.message}</li>
            ))}
          </ul>
        </div>
      )}

      <form
        method="POST"
        action={`/cms/media/${media.id}`}
        className="cms-media-detail"
        data-cms-form
      >
        <input type="hidden" name="_csrf" value={csrfToken} />

        <fieldset className="cms-field cms-focal-field">
          <legend className="cms-field-label">Focal point</legend>
          <p className="cms-field-help">
            Click the picture to choose what stays in view when the image is
            cropped.
          </p>
          <button
            type="button"
            className="cms-focal"
            data-focal-picker
            aria-label="Click or use the arrow keys to set the focal point"
          >
            <img className="cms-focal-image" src={pickerUrl} alt="" />
            <span
              className="cms-focal-marker"
              data-focal-marker
              aria-hidden="true"
              style={`left:${x}%;top:${y}%`}
            />
          </button>
        </fieldset>

        <div className="cms-focal-previews">
          {["16:9", "1:1", "4:5"].map((ratio) => (
            <figure key={ratio} className="cms-focal-preview">
              <img
                data-focal-preview
                src={previewUrl}
                alt=""
                style={`aspect-ratio:${ratio.replace(":", "/")};object-fit:cover;${position}`}
              />
              <figcaption>{ratio}</figcaption>
            </figure>
          ))}
        </div>

        <input
          type="hidden"
          name="focal_x"
          value={String(media.focalX)}
          data-focal-x
        />
        <input
          type="hidden"
          name="focal_y"
          value={String(media.focalY)}
          data-focal-y
        />

        <div className="cms-field">
          <label className="cms-field-label" htmlFor="cms-media-alt">
            Alt text <span className="cms-required">*</span>
          </label>
          <input
            type="text"
            id="cms-media-alt"
            name="alt"
            required
            maxLength={MAX_ALT_LENGTH}
            value={media.alt}
          />
          <span className="cms-field-help">
            A page can override this for one use.
          </span>
        </div>

        <button type="submit" className="cms-save">
          Save
        </button>
      </form>

      <script type="module" src={getAssetUrl("/assets/cms-form.js")} />

      <section className="cms-media-uses" aria-label="Image usage">
        <h2>Uses</h2>
        {usage.length === 0 ? (
          <p>Not used by any published page or slot.</p>
        ) : (
          <ul className="cms-media-usage">
            {usage.map((entry) => (
              <li key={`${entry.kind}:${entry.id}`}>
                <a
                  href={`/cms/${entry.kind === "page" ? "pages" : "slots"}/${entry.id}`}
                >
                  {entry.label}
                </a>{" "}
                <code>{entry.detail}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="cms-media-delete">
          {usage.length > 0 ? (
            <>
              This image is used by published content, so it can't be deleted.
              Remove it from the pages and slots above first.
            </>
          ) : (
            <a
              className="cms-delete-button"
              href={`/cms/media/${media.id}/delete`}
            >
              Delete image
            </a>
          )}
        </p>
      </section>
    </Layout>
  );
};

export interface MediaDeleteConfirmProps {
  user: User;
  csrfToken: string;
  navCsrfToken?: string;
  media: MediaRecord;
}

/** The confirm step before an unused image is deleted. */
export const MediaDeleteConfirm = ({
  user,
  csrfToken,
  navCsrfToken,
  media,
}: MediaDeleteConfirmProps) => (
  <Layout
    title={`Delete ${media.alt} - Billet CMS`}
    name="cms"
    description="Confirm deleting an image."
    canonicalPath={`/cms/media/${media.id}/delete`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <a href="/cms/media">Media</a> /{" "}
      <a href={`/cms/media/${media.id}`}>{media.alt}</a> / <span>Delete</span>
    </p>
    <h1>Delete this image?</h1>
    <img
      className="cms-media-delete-preview"
      src={variantForDisplay(media, DELETE_PREVIEW_WIDTH)?.fallbackUrl ?? ""}
      alt={media.alt}
      width={media.width}
      height={media.height}
    />
    <p>
      This removes the image and every rendition from the bucket. It can't be
      undone.
    </p>
    <form method="POST" action={`/cms/media/${media.id}/delete`}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      <button type="submit" className="cms-delete-button">
        Delete image
      </button>
      <a className="cms-delete-cancel" href={`/cms/media/${media.id}`}>
        Cancel
      </a>
    </form>
  </Layout>
);
