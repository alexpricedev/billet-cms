/**
 * Video links, parsed into the provider and id the stored value keeps.
 *
 * The CMS never stores the address an editor pasted. A `video()` field holds
 * `{ provider, id, title }`, and the site builds the player's `src` from those
 * two parts — so no arbitrary URL an editor typed can reach an iframe, and the
 * privacy-friendly host is decided once here rather than by every site. The
 * pasted address only exists long enough for the form's save to be normalised
 * into that shape; see `normaliseVideoContent`.
 *
 * Parsing lives in the plugin, beside the field vocabulary, because the CMS's
 * write paths and a site that accepts content another way both need the same
 * answer about what counts as a video link.
 */

/** The services a video field can name. */
export type VideoProvider = "youtube" | "vimeo";

/** The part of a video value an embed needs: which service, which video. */
export interface VideoRef {
  provider: VideoProvider;
  id: string;
}

/** What a `video()` field stores: the reference plus the iframe's title. */
export interface VideoValue extends VideoRef {
  title: string;
}

/** The message shown for a link that is not one of the two services' videos. */
export const VIDEO_URL_MESSAGE = "Paste a YouTube or Vimeo link.";

/** The message shown when a video has no title for its iframe. */
export const VIDEO_TITLE_MESSAGE = "Add a title for the video.";

/**
 * A YouTube video id: eleven characters of the URL-safe alphabet.
 *
 * Checked rather than taken from the path as-is, because the id is
 * interpolated into the embed URL the site renders. A path segment of `../…`
 * or a second `/` would otherwise travel into an iframe `src`.
 */
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** A Vimeo video id: digits only, for the same reason. */
export const VIMEO_ID_PATTERN = /^\d+$/;

/**
 * The YouTube id in `url`, or `null` when the host or path is not a video.
 *
 * Only `https:` reaches here (`parseVideoUrl` checks the scheme), and query
 * parameters other than `watch`'s `v` are ignored: a `t=` start time or a
 * `list=` playlist is not part of what the field stores, so a pasted link that
 * carries one still resolves to the same video.
 */
const youTubeId = (url: URL): string | null => {
  switch (url.hostname) {
    case "youtu.be": {
      const match = /^\/([^/]+)\/?$/.exec(url.pathname);
      return match && YOUTUBE_ID_PATTERN.test(match[1]) ? match[1] : null;
    }
    case "youtube.com":
    case "www.youtube.com":
    case "m.youtube.com": {
      if (url.pathname === "/watch" || url.pathname === "/watch/") {
        const id = url.searchParams.get("v") ?? "";
        return YOUTUBE_ID_PATTERN.test(id) ? id : null;
      }
      const match = /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(url.pathname);
      return match && YOUTUBE_ID_PATTERN.test(match[1]) ? match[1] : null;
    }
    // The host the embed itself uses. An editor who copies an embed's `src`,
    // or a link out of a privacy-minded site, pastes this one.
    case "youtube-nocookie.com":
    case "www.youtube-nocookie.com": {
      const match = /^\/embed\/([^/]+)\/?$/.exec(url.pathname);
      return match && YOUTUBE_ID_PATTERN.test(match[1]) ? match[1] : null;
    }
    default:
      return null;
  }
};

/**
 * The Vimeo id in `url`, or `null` when the host or path is not a video.
 *
 * An unlisted video's hash is the part that lets it play, whether it arrives as
 * a path segment (`vimeo.com/ID/HASH`) or as `?h=` on the player URL. The
 * stored value has nowhere to keep one, so either form is refused rather than
 * stored as a player that says the video is private.
 */
const vimeoId = (url: URL): string | null => {
  if (url.searchParams.has("h")) return null;
  const pattern =
    url.hostname === "vimeo.com"
      ? /^\/([^/]+)\/?$/
      : url.hostname === "player.vimeo.com"
        ? /^\/video\/([^/]+)\/?$/
        : null;
  if (!pattern) return null;
  const match = pattern.exec(url.pathname);
  return match && VIMEO_ID_PATTERN.test(match[1]) ? match[1] : null;
};

/**
 * The provider and id a pasted link names, or `null` when it names neither.
 *
 * `https` only: a link pasted from a browser's address bar is https, and
 * accepting `http` would mean a stored value that quietly upgrades a scheme
 * the editor did not choose. Everything else — another site, another video
 * service, `javascript:` — is refused with `VIDEO_URL_MESSAGE`, so the editor
 * learns which two services work rather than getting a generic failure.
 */
export const parseVideoUrl = (value: string): VideoRef | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const youtube = youTubeId(url);
  if (youtube !== null) return { provider: "youtube", id: youtube };

  const vimeo = vimeoId(url);
  if (vimeo !== null) return { provider: "vimeo", id: vimeo };

  return null;
};

/**
 * The address an embed for `video` loads, or `""` for a value that cannot be
 * embedded.
 *
 * Nothing but this function's two fixed origins is ever returned: the id is
 * checked against its provider's pattern first, so a hand-written stored value
 * — from an import, an MCP caller or an old row — cannot put a path of its own
 * into the iframe. `youtube-nocookie.com` and Vimeo's `dnt=1` are the
 * privacy-friendly forms; a site never has to remember them.
 */
export const videoEmbedUrl = (video: VideoRef): string => {
  switch (video.provider) {
    case "youtube":
      return YOUTUBE_ID_PATTERN.test(video.id)
        ? `https://www.youtube-nocookie.com/embed/${video.id}`
        : "";
    case "vimeo":
      return VIMEO_ID_PATTERN.test(video.id)
        ? `https://player.vimeo.com/video/${video.id}?dnt=1`
        : "";
    default:
      return "";
  }
};

/** One field-relative problem, in the shape the CMS's form points at. */
export interface VideoContentIssue {
  /** Dotted path to the failing box, e.g. `clips.0.url`. */
  path: string;
  message: string;
}

/**
 * The part of a published field's metadata the walk reads.
 *
 * Structural rather than the contract's `FieldMetadata`: normalising needs a
 * field's name, its kind and its two child lists, and nothing else. Every
 * `FieldMetadata` satisfies this, so a caller passes the tree it already has.
 */
interface MetadataNode {
  readonly name: string;
  readonly kind: string;
  readonly required: boolean;
  readonly of?: MetadataNode;
  readonly fields?: readonly MetadataNode[];
}

/**
 * Marks a value that should not appear in the content at all.
 *
 * An optional video the editor left completely blank is absent, not a stored
 * value with empty parts — the same way an optional image with no picture is.
 * The key is deleted rather than set to `undefined` so the object the schema
 * validates has no hole in it.
 */
const ABSENT = Symbol("absent");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a form box, or `""` for a missing or non-string value. */
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const issuePath = (path: readonly (string | number)[], leaf: string): string =>
  [...path, leaf].join(".");

/**
 * Normalise one video value, from the form's `{ url, title }` to the stored
 * `{ provider, id, title }`.
 *
 * A refusal keeps the raw value rather than replacing it: the form re-renders
 * what the editor typed so they can correct it, and the message lands on the
 * box that is wrong. The schema never sees the raw shape on a successful save
 * because this returns the stored one.
 */
const normaliseVideo = (
  field: MetadataNode,
  value: unknown,
  path: readonly (string | number)[],
  issues: VideoContentIssue[],
): unknown => {
  if (!isRecord(value)) return value;

  // A value that already names a provider or an id is the stored shape, or an
  // attempt at one. Leave it to the schema, whose per-provider id pattern and
  // strict keys are the authority. Form values never carry either key.
  if ("provider" in value || "id" in value) return value;

  const url = text(value.url);
  const title = text(value.title);

  if (url === "" && title === "") {
    // An optional field nobody filled is absent. A required one posts while
    // blank on purpose, so the message can name the box the editor has to fill
    // rather than reporting the whole field as missing.
    if (field.required) {
      issues.push({
        path: issuePath(path, "url"),
        message: VIDEO_URL_MESSAGE,
      });
      return value;
    }
    return ABSENT;
  }

  const parsed = parseVideoUrl(url);
  if (parsed === null) {
    issues.push({ path: issuePath(path, "url"), message: VIDEO_URL_MESSAGE });
  }
  if (title === "") {
    issues.push({
      path: issuePath(path, "title"),
      message: VIDEO_TITLE_MESSAGE,
    });
  }
  if (parsed === null || title === "") return value;

  return { provider: parsed.provider, id: parsed.id, title };
};

/**
 * Normalise one field's value, following a list's `of` and a group's `fields`
 * so a video nested in either is reached.
 *
 * A list item is a bare value with no key to look itself up by, which is why
 * the walk carries the metadata alongside it (the mistake that once left
 * `image()` inside `list()` uncollected). Groups are copied before their
 * children are replaced so the caller's content object is never mutated.
 */
const normaliseNode = (
  field: MetadataNode,
  value: unknown,
  path: readonly (string | number)[],
  issues: VideoContentIssue[],
): unknown => {
  if (field.kind === "video") {
    return normaliseVideo(field, value, path, issues);
  }

  if (field.kind === "list") {
    const of = field.of;
    if (!of || !Array.isArray(value)) return value;
    return value.map((item, index) =>
      normaliseNode(of, item, [...path, index], issues),
    );
  }

  if (field.kind === "group") {
    if (!field.fields || !isRecord(value)) return value;
    const next = { ...value };
    for (const child of field.fields) {
      const childValue = normaliseNode(
        child,
        next[child.name],
        [...path, child.name],
        issues,
      );
      if (childValue === ABSENT) delete next[child.name];
      else next[child.name] = childValue;
    }
    return next;
  }

  return value;
};

/** The normalised content and the problems that stopped a video being stored. */
export interface NormalisedVideoContent {
  /**
   * The content with every video in its stored shape. A video that could not
   * be normalised is left exactly as the editor typed it, so a refused save
   * can render it back.
   */
  content: unknown;
  /** One issue per failing box, ready for the CMS's field errors. */
  issues: VideoContentIssue[];
}

/**
 * Turn every pasted video link in `content` into its stored shape.
 *
 * The form posts `{ url, title }` for each video — the pasted address and the
 * iframe's title — because parsing on the client would be a second
 * implementation of the allowlist and would not work with JavaScript off. The
 * server parses instead, here, before `blockContentIssues` runs, so what the
 * schema validates is the value that will be saved.
 *
 * Issues use the same dotted-path shape as the CMS's field errors, so the form
 * can put "Paste a YouTube or Vimeo link." under the link box and "Add a title
 * for the video." under the title box.
 */
export const normaliseVideoContent = (
  fields: readonly MetadataNode[],
  content: unknown,
): NormalisedVideoContent => {
  const issues: VideoContentIssue[] = [];
  if (!isRecord(content)) return { content, issues };

  // Copied rather than rebuilt from the declared fields: a key no field
  // declares must still reach the strict schema, which refuses it, instead of
  // being dropped here as if it had never been sent.
  const next: Record<string, unknown> = { ...content };
  for (const field of fields) {
    const value = normaliseNode(field, next[field.name], [field.name], issues);
    if (value === ABSENT) delete next[field.name];
    else next[field.name] = value;
  }
  return { content: next, issues };
};
