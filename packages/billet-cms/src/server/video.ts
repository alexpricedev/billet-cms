/**
 * Rendering a stored video value as a player, for the site.
 *
 * A `video()` field stores `{ provider, id, title }` — never the address the
 * editor pasted (see `../fields/video`). A site hands that value to
 * `renderCmsVideo`, the plugin's `<CmsVideo>`:
 *
 *   return renderCmsVideo(content.clip);
 *
 * The `<iframe>`'s `src` is built only by `videoEmbedUrl`, from the provider
 * and an id that already matches that provider's pattern. Nothing an editor
 * typed reaches the address: the two origins here are fixed, and a value whose
 * id does not fit — a hand-edited row, an import, an old revision — renders as
 * an empty string, the same way `renderCmsImage` renders a row with no
 * renditions. `title` is the iframe's accessible name and is required by the
 * stored schema; a missing or blank one is refused here too, because an
 * untitled frame is announced as just "frame".
 *
 * The box is 16:9 via `aspect-ratio`, so the player reserves its space before
 * the third-party document loads and does not shift the page. Both providers
 * are embedded in their privacy-friendly form: YouTube through
 * `youtube-nocookie.com`, Vimeo with `dnt=1`.
 */
import { MAX_ALT_LENGTH } from "../contract";
import { type VideoValue, videoEmbedUrl } from "../fields/video";
import { escapeHtml } from "./rich-text";

/**
 * Render one video value as a 16:9 `<iframe>`, or `""` when it cannot be
 * embedded.
 *
 * The guard repeats the stored schema's checks on purpose. A public page reads
 * `cms_revisions`, which a hand edit or another writer can put anything into;
 * returning nothing is better than an iframe pointed at a URL of the row's
 * choosing, or a frame a screen reader cannot name.
 */
export const renderCmsVideo = (video: VideoValue): string => {
  // `video` is typed as the stored shape, but a caller interpolating a row it
  // did not validate can still hand over a missing value.
  if (!video || typeof video !== "object") return "";

  const src = videoEmbedUrl(video);
  if (src === "") return "";

  const title = typeof video.title === "string" ? video.title.trim() : "";
  if (title === "" || title.length > MAX_ALT_LENGTH) return "";

  const attributes = [
    `src="${escapeHtml(src)}"`,
    `title="${escapeHtml(title)}"`,
    `loading="lazy"`,
    "allowfullscreen",
    `style="aspect-ratio:16/9;width:100%;border:0"`,
  ].join(" ");

  return `<iframe ${attributes}></iframe>`;
};
