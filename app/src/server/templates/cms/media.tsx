import type { MediaVariant } from "@alexpricedev/billet-cms/contract";
import type { PickerImage } from "../../components/cms/image-picker";
import { Flash } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import { getAssetUrl } from "../../services/assets";
import {
  MAX_ALT_LENGTH,
  type MediaIssue,
  type MediaRecord,
  type MediaUsage,
} from "../../services/media";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";

export interface MediaListProps {
  user: User;
  /** The CSRF token bound to the upload POST. */
  csrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  items: MediaRecord[];
  notice?: string | null;
}

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
  media: Pick<MediaRecord, "variants">,
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
export const GRID_THUMBNAIL_WIDTH = 12 * 16;

/**
 * The picker's shape for one upload: what a library card and the closed field
 * both show. Shared by the options route, the JSON upload answer and the page
 * form, so a pick looks the same wherever it is drawn.
 */
export const pickerOptionJson = (
  media: Pick<MediaRecord, "id" | "alt" | "width" | "height" | "variants">,
): PickerImage => ({
  id: media.id,
  alt: media.alt,
  width: media.width,
  height: media.height,
  thumbnailUrl:
    variantForDisplay(media, GRID_THUMBNAIL_WIDTH)?.fallbackUrl ?? null,
});

/**
 * The one-line usage summary under the heading: "1 page", "2 pages",
 * "2 pages and 1 slot".
 *
 * A kind with no uses is dropped rather than printed as "0 slots", so an
 * image used by one page never reads "1 pages and 0 slots".
 */
const usageSummary = (usage: MediaUsage[]): string => {
  const pages = usage.filter((entry) => entry.kind === "page").length;
  const slots = usage.filter((entry) => entry.kind === "slot").length;
  return [
    pages > 0 ? `${pages} ${pages === 1 ? "page" : "pages"}` : null,
    slots > 0 ? `${slots} ${slots === 1 ? "slot" : "slots"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
};
const FOCAL_PICKER_WIDTH = 32 * 16;
// The picker is a click target, not a full-bleed image, so it stops at the 960
// rendition rather than pulling the 1600/2400 one the 2x rule would pick.
const FOCAL_PICKER_MAX_WIDTH = 960;
const FOCAL_PREVIEW_WIDTH = 10 * 16;
const DELETE_PREVIEW_WIDTH = 24 * 16;

/**
 * The uploads library: the staged-upload drop zone and the reuse list.
 *
 * The page cannot upload without JavaScript (the third recorded client
 * exception in AGENTS.md): `client/media-upload.ts` turns dropped or chosen
 * files into tiles that ask for alt text before sending anything, and adds a
 * finished upload to the front of the grid without a reload. This template
 * renders the drop zone and the grid the script binds to, and the note that
 * says the script is needed.
 *
 * The list is deliberately flat (no folders yet): every upload, newest first,
 * with a thumbnail, its alt text and its dimensions. Clicking one opens its
 * detail, where the alt and the focal point are edited.
 */
export const MediaList = ({
  user,
  csrfToken,
  navCsrfToken,
  items,
  notice,
}: MediaListProps) => (
  <Layout
    title={`Media - ${SITE_NAME}`}
    name="cms"
    description="Upload and reuse images."
    canonicalPath="/cms/media"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <span>Media</span>
        </>
      }
      title="Media"
      description="Upload an image once and reuse it across the site. Alt text is required; JPEG, PNG and WebP up to 20 MB."
    />

    {notice && <Flash tone="success" title={notice} dismissible />}

    {/* The drop zone, the batch action and the staged tiles. The client finds
        these by `data-media-*`; it builds one tile per file and nothing is
        sent until that tile has alt text and its Upload is pressed. */}
    <section
      className="cms-media-uploader"
      data-media-upload
      data-media-upload-csrf={csrfToken}
      aria-label="Upload images"
    >
      <div className="cms-picker-drop" data-media-drop>
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
            data-media-file
          />
        </label>
        <p className="cms-field-help">
          JPEG, PNG or WebP up to 20 MB. Uploading needs JavaScript.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm cms-media-upload-all"
        data-media-upload-all
        hidden
      >
        Upload all
      </button>
      <ul className="cms-media-tiles" data-media-staged />
    </section>

    <div className="cms-media-library">
      <div
        className="empty-state"
        role="status"
        data-media-empty
        hidden={items.length > 0}
      >
        <span className="empty-state-title">No images yet</span>
        <span>Upload one above to use it in an image field.</span>
      </div>

      {/* Rendered even when empty: the client prepends a finished upload here
          without a reload, and hides the empty state above with it. */}
      <ul className="cms-media-grid" data-media-grid>
        {items.map((media) => {
          const thumbnail =
            variantForDisplay(media, GRID_THUMBNAIL_WIDTH)?.fallbackUrl ?? null;
          return (
            <li className="cms-media-card" key={media.id}>
              <a href={`/cms/media/${media.id}`}>
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt={media.alt}
                    width={media.width}
                    height={media.height}
                    loading="lazy"
                  />
                ) : (
                  <span className="cms-media-placeholder">{media.alt}</span>
                )}
              </a>
              <a className="cms-media-alt" href={`/cms/media/${media.id}`}>
                {media.alt}
              </a>
              <span className="cms-media-meta">
                {media.width}×{media.height}
              </span>
            </li>
          );
        })}
      </ul>
    </div>

    <script type="module" src={getAssetUrl("/assets/media-upload.js")} />
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
      title={`${media.alt} - Media - ${SITE_NAME}`}
      name="cms"
      description="Edit an image's alt text and focal point."
      canonicalPath={`/cms/media/${media.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <PageHeader
        breadcrumb={
          <>
            <a href="/cms">Content</a> / <a href="/cms/media">Media</a> /{" "}
            <span>{media.alt}</span>
          </>
        }
        title="Image"
        description={
          usage.length === 0 ? (
            "Not used anywhere."
          ) : (
            <>
              <a href="#uses">Used on {usageSummary(usage)}</a>, so it can't be
              deleted.
            </>
          )
        }
        after={
          // The reuse lists in the page and slot forms list only the newest
          // uploads, and an editor who needs an older one pastes its id here.
          <p className="cms-media-meta">
            Media id <code>{media.id}</code>
          </p>
        }
      />

      {notice && (
        <Flash tone={notice.kind} title={notice.message} dismissible />
      )}

      {errors?.map((error) => (
        <Flash
          key={`${error.field}:${error.message}`}
          tone="error"
          title={error.message}
          dismissible
        />
      ))}

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
            aria-describedby="cms-media-alt-help"
          />
          <span className="cms-field-help" id="cms-media-alt-help">
            A page can override this for one use. Up to {MAX_ALT_LENGTH}{" "}
            characters.
          </span>
        </div>

        <button type="submit" className="cms-save btn btn-primary">
          Save
        </button>
      </form>

      <script type="module" src={getAssetUrl("/assets/cms-form.js")} />

      <section id="uses" className="cms-media-uses" aria-label="Image usage">
        <h2>Uses</h2>
        {usage.length === 0 ? (
          <p>Not used by any page, slot or social image.</p>
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
              This image is used by published content or a page's social image,
              so it can't be deleted. Remove it from the pages and slots above
              first.
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
    title={`Delete ${media.alt} - ${SITE_NAME}`}
    name="cms"
    description="Confirm deleting an image."
    canonicalPath={`/cms/media/${media.id}/delete`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <a href="/cms/media">Media</a> /{" "}
          <a href={`/cms/media/${media.id}`}>{media.alt}</a> /{" "}
          <span>Delete</span>
        </>
      }
      title="Delete this image?"
    />
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
