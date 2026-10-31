/**
 * The Media page's staged upload tiles.
 *
 * This is part of the third recorded client exception (AGENTS.md). The Media
 * page cannot be a plain form once a dropped file has to become a tile with its
 * own alt box before it is stored: dropping several files, typing alt text per
 * file and uploading one or all without a reload is what the ticket asks for.
 * The upload itself is `upload-shared.ts`'s — the same request the image
 * picker sends — so this module only owns what happens before and after it.
 *
 * Every node is built with `createElement` and `textContent`, never
 * `innerHTML`, so a file name or a server message can only become text.
 * `boundaries.test.ts` allows the three departures in `image-picker.ts` and
 * `upload-shared.ts`; this file adds no new one — it is the staged-tile state
 * around that shared upload.
 *
 * The page is unreadable without JavaScript and says so in the template: the
 * drop zone, the tiles and the grid's new cards all need this script.
 */

import {
  imagePreview,
  type MediaOption,
  revokePreview,
  type UploadPreview,
  uploadFile,
} from "./upload-shared";

/**
 * The upload limits, mirrored from `@alexpricedev/billet-cms/contract`.
 *
 * The contract module imports `node:crypto` (its schema hash), so bundling it
 * into a page would put crypto in the browser build. `media-upload.test.ts`
 * pins these numbers to the contract's, and the server's sniffed-type check
 * stays the real gate: the browser can only read the declared type.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_ALT_LENGTH = 1000;
export const UPLOAD_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

/** How long an uploaded tile stays before it clears itself. */
export const UPLOADED_TILE_LINGER_MS = 800;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Why the browser can already refuse a file, or null when it should be staged.
 *
 * An empty `type` is what a browser reports for a file it could not identify;
 * the server sniffs the bytes, so guessing here would refuse a valid upload.
 */
const refusalFor = (file: File): string | null => {
  if (file.type !== "" && !UPLOAD_TYPES.includes(file.type)) {
    return "That file isn't a JPEG, PNG or WebP image.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That image is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Resize it and try again.`;
  }
  return null;
};

interface UploaderElements {
  drop: HTMLElement;
  file: HTMLInputElement;
  uploadAll: HTMLButtonElement;
  staged: HTMLElement;
}

const must = <T extends Element>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`media uploader: no ${selector}`);
  return found;
};

const elementsFor = (root: HTMLElement): UploaderElements => ({
  drop: must<HTMLElement>(root, "[data-media-drop]"),
  file: must<HTMLInputElement>(root, "[data-media-file]"),
  uploadAll: must<HTMLButtonElement>(root, "[data-media-upload-all]"),
  staged: must<HTMLElement>(root, "[data-media-staged]"),
});

/** One staged file and the nodes whose state follows it. */
interface StagedTile {
  item: HTMLLIElement;
  file: File;
  alt: HTMLInputElement;
  upload: HTMLButtonElement;
  remove: HTMLButtonElement;
  error: HTMLElement;
  progress: HTMLElement;
  bar: HTMLElement;
  state: HTMLElement;
  preview: UploadPreview | null;
  /** The browser already knows this file can never upload (type or size). */
  invalid: boolean;
}

let tileSequence = 0;

const hasAlt = (tile: StagedTile): boolean => tile.alt.value.trim() !== "";

const setError = (tile: StagedTile, message: string | null): void => {
  if (message === null) {
    tile.error.hidden = true;
    tile.error.textContent = "";
    return;
  }
  tile.error.textContent = message;
  tile.error.hidden = false;
};

/** Replace a preview the browser could not draw with a neutral tile. */
const placeholder = (): HTMLElement => {
  const span = document.createElement("span");
  span.className = "cms-media-tile-placeholder";
  span.textContent = "No preview";
  return span;
};

const createTile = (file: File, refusal: string | null): StagedTile => {
  const item = document.createElement("li");
  item.className = "cms-media-tile";
  item.dataset.mediaTile = "";
  item.dataset.state = "staged";
  if (refusal !== null) item.dataset.invalid = "true";

  const previewBox = document.createElement("span");
  previewBox.className = "cms-media-tile-preview";
  previewBox.dataset.mediaPreview = "";
  const preview = imagePreview(file);
  if (preview) {
    preview.image.addEventListener("error", () => {
      previewBox.replaceChildren(placeholder());
    });
    previewBox.append(preview.image);
  } else {
    previewBox.append(placeholder());
  }

  const body = document.createElement("div");
  body.className = "cms-media-tile-body";

  const heading = document.createElement("div");
  heading.className = "cms-media-tile-heading";
  const name = document.createElement("span");
  name.className = "cms-media-tile-name";
  name.dataset.mediaName = "";
  name.textContent = file.name;
  const meta = document.createElement("span");
  meta.className = "cms-media-tile-meta";
  meta.dataset.mediaMeta = "";
  meta.textContent = formatBytes(file.size);
  heading.append(name, meta);
  body.append(heading);

  tileSequence += 1;
  const altId = `cms-media-tile-alt-${tileSequence}`;
  const label = document.createElement("label");
  label.className = "cms-field-label";
  label.htmlFor = altId;
  label.textContent = "Alt text";
  const alt = document.createElement("input");
  alt.type = "text";
  alt.className = "cms-media-tile-alt";
  alt.id = altId;
  alt.maxLength = MAX_ALT_LENGTH;
  alt.required = true;
  alt.dataset.mediaAlt = "";
  alt.setAttribute("autocomplete", "off");
  const helpId = `${altId}-help`;
  alt.setAttribute("aria-describedby", helpId);
  const help = document.createElement("span");
  help.className = "cms-field-help";
  help.id = helpId;
  help.textContent = `Up to ${MAX_ALT_LENGTH} characters.`;
  body.append(label, alt, help);

  const error = document.createElement("p");
  error.className = "cms-media-tile-error";
  error.dataset.mediaError = "";
  error.setAttribute("role", "alert");
  error.hidden = true;
  body.append(error);

  const progress = document.createElement("span");
  progress.className = "cms-picker-progress";
  progress.dataset.mediaProgress = "";
  progress.hidden = true;
  const bar = document.createElement("span");
  bar.className = "cms-picker-progress-bar";
  bar.dataset.mediaBar = "";
  bar.style.width = "0%";
  progress.append(bar);
  body.append(progress);

  const state = document.createElement("span");
  state.className = "cms-picker-upload-state";
  state.dataset.mediaState = "";
  body.append(state);

  const actions = document.createElement("div");
  actions.className = "cms-media-tile-actions";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "btn btn-primary btn-sm";
  upload.dataset.mediaTileUpload = "";
  upload.textContent = "Upload";
  upload.disabled = true;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-ghost btn-sm";
  remove.dataset.mediaTileRemove = "";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${file.name}`);
  remove.title = "Remove";
  actions.append(upload, remove);
  body.append(actions);

  item.append(previewBox, body);

  if (refusal !== null) {
    // The browser can already see this one will be refused: say why now, and
    // leave only Remove available — there is nothing to type alt text for.
    item.dataset.state = "error";
    error.textContent = refusal;
    error.hidden = false;
    alt.disabled = true;
  }

  return {
    item,
    file,
    alt,
    upload,
    remove,
    error,
    progress,
    bar,
    state,
    preview,
    invalid: refusal !== null,
  };
};

/** Add a tile for each file; nothing is sent until its Upload is pressed. */
const wireUploader = (root: HTMLElement): void => {
  const el = elementsFor(root);
  // Replaced when the server hands back a fresh token after an expired one.
  let token = root.dataset.mediaUploadCsrf ?? "";
  const tiles: StagedTile[] = [];
  let batch = false;

  const grid = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-media-grid]");

  const hasUnsent = (): boolean =>
    tiles.some((tile) => tile.item.dataset.state !== "done");

  const onBeforeUnload = (event: Event): void => {
    // A test (or a page rebuilt in place) can leave a listener behind; the
    // drop zone's own removal is the end of what it was guarding.
    if (!root.isConnected || !hasUnsent()) return;
    event.preventDefault();
    // Legacy browsers read `returnValue`; the string is not shown.
    (event as BeforeUnloadEvent).returnValue = "";
  };
  let guardAttached = false;

  const updateLeaveGuard = (): void => {
    if (hasUnsent() && !guardAttached) {
      window.addEventListener("beforeunload", onBeforeUnload);
      guardAttached = true;
    } else if (!hasUnsent() && guardAttached) {
      window.removeEventListener("beforeunload", onBeforeUnload);
      guardAttached = false;
    }
  };

  const syncTile = (tile: StagedTile): void => {
    const sending = tile.item.dataset.state === "uploading";
    const done = tile.item.dataset.state === "done";
    tile.upload.disabled = tile.invalid || sending || done || !hasAlt(tile);
    tile.remove.disabled = sending || done;
    tile.alt.disabled = tile.invalid || sending || done;
  };

  /**
   * Upload all is for the batch that is still to send: at least one tile with
   * alt text, every such tile filled in, and not already running.
   *
   * A file the browser refused is left out — it can never upload, so it must
   * not hold the batch hostage — but it still counts as a tile, so two staged
   * files of which one is refused still show the button.
   */
  const syncUploadAll = (): void => {
    const uploadable = tiles.filter(
      (tile) => !tile.invalid && tile.item.dataset.state !== "done",
    );
    el.uploadAll.hidden = tiles.length < 2;
    el.uploadAll.disabled =
      batch ||
      uploadable.length === 0 ||
      !uploadable.every((tile) => hasAlt(tile));
  };

  const removeTile = (tile: StagedTile): void => {
    const index = tiles.indexOf(tile);
    if (index !== -1) tiles.splice(index, 1);
    revokePreview(tile.preview);
    tile.preview = null;
    tile.item.remove();
    syncUploadAll();
    updateLeaveGuard();
  };

  /** A sent tile clears itself once its card is in the grid. */
  const clearWhenDone = (tile: StagedTile): void => {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      removeTile(tile);
      return;
    }
    setTimeout(() => removeTile(tile), UPLOADED_TILE_LINGER_MS);
  };

  /** Put the new upload at the front of the library grid, without a reload. */
  const prependCard = (option: MediaOption): void => {
    const list = grid();
    if (!list) return;

    const card = document.createElement("li");
    card.className = "cms-media-card";
    card.dataset.mediaCard = "";

    const href = `/cms/media/${option.id}`;
    const imageLink = document.createElement("a");
    imageLink.href = href;
    if (option.thumbnailUrl) {
      const image = document.createElement("img");
      image.src = option.thumbnailUrl;
      image.alt = option.alt;
      image.width = option.width;
      image.height = option.height;
      image.loading = "lazy";
      imageLink.append(image);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "cms-media-placeholder";
      fallback.textContent = option.alt;
      imageLink.append(fallback);
    }

    const altLink = document.createElement("a");
    altLink.className = "cms-media-alt";
    altLink.href = href;
    altLink.textContent = option.alt;

    const meta = document.createElement("span");
    meta.className = "cms-media-meta";
    meta.textContent = `${option.width}×${option.height}`;

    card.append(imageLink, altLink, meta);
    list.prepend(card);
    // The empty state stops being true the moment a card exists.
    const empty = document.querySelector<HTMLElement>("[data-media-empty]");
    if (empty) empty.hidden = true;
  };

  /** Send one tile, keeping the file and alt text whatever the server says. */
  const uploadTile = async (tile: StagedTile): Promise<void> => {
    if (
      tile.invalid ||
      tile.item.dataset.state === "uploading" ||
      tile.item.dataset.state === "done" ||
      !hasAlt(tile)
    ) {
      return;
    }

    const alt = tile.alt.value.trim();
    tile.item.dataset.state = "uploading";
    setError(tile, null);
    tile.progress.hidden = false;
    tile.bar.style.width = "0%";
    tile.state.textContent = "Uploading…";
    syncTile(tile);
    updateLeaveGuard();

    const answer = await uploadFile({
      file: tile.file,
      alt,
      token,
      onProgress: (percent) => {
        tile.bar.style.width = `${percent}%`;
      },
    });
    token = answer.token;

    if (answer.result.ok) {
      tile.item.dataset.state = "done";
      tile.bar.style.width = "100%";
      tile.progress.hidden = true;
      tile.state.textContent = "Uploaded";
      syncTile(tile);
      prependCard(answer.result.option);
      updateLeaveGuard();
      clearWhenDone(tile);
      return;
    }

    // A refusal is not a lost file: the tile keeps both, so the editor can fix
    // the alt or the picture and press Upload again.
    tile.item.dataset.state = "error";
    tile.progress.hidden = true;
    tile.state.textContent = "";
    setError(tile, answer.result.message);
    syncTile(tile);
    updateLeaveGuard();
  };

  const stageFiles = (files: File[]): void => {
    for (const file of files) {
      const tile = createTile(file, refusalFor(file));
      tiles.push(tile);
      el.staged.append(tile.item);

      tile.alt.addEventListener("input", () => {
        syncTile(tile);
        syncUploadAll();
      });
      tile.alt.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        // Enter is this tile's Upload; it must not do anything else.
        event.preventDefault();
        void uploadTile(tile);
      });
      tile.upload.addEventListener("click", () => {
        void uploadTile(tile);
      });
      tile.remove.addEventListener("click", () => {
        removeTile(tile);
      });

      syncTile(tile);
    }

    // The editor starts typing where the next sentence is missing.
    const empty = tiles.find((tile) => !tile.invalid && !hasAlt(tile));
    empty?.alt.focus();
    syncUploadAll();
    updateLeaveGuard();
  };

  const uploadAll = async (): Promise<void> => {
    if (batch) return;
    const batchTiles = tiles.filter(
      (tile) =>
        !tile.invalid &&
        (tile.item.dataset.state === "staged" ||
          tile.item.dataset.state === "error") &&
        hasAlt(tile),
    );
    if (batchTiles.length === 0) return;
    batch = true;
    syncUploadAll();
    try {
      for (const tile of batchTiles) {
        // A tile removed while the batch ran is no longer in the list.
        if (tiles.includes(tile)) await uploadTile(tile);
      }
    } finally {
      batch = false;
      syncUploadAll();
    }
  };

  el.file.addEventListener("change", () => {
    // A browser empties the input's live FileList when `value` is reset, so
    // copy it first; reading it afterwards uploads nothing.
    const files = Array.from(el.file.files ?? []);
    el.file.value = "";
    stageFiles(files);
  });

  el.drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.drop.classList.add("is-dragover");
  });
  el.drop.addEventListener("dragleave", () => {
    el.drop.classList.remove("is-dragover");
  });
  el.drop.addEventListener("drop", (event) => {
    event.preventDefault();
    el.drop.classList.remove("is-dragover");
    stageFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  el.uploadAll.addEventListener("click", () => {
    void uploadAll();
  });

  syncUploadAll();
};

const UPLOADER = "[data-media-upload]";

/**
 * Bind the Media page's uploader.
 *
 * Marked once so a test that calls `init` after the module's own run does not
 * bind the same drop zone twice (two handlers would stage every file twice).
 */
export const init = (): void => {
  for (const root of Array.from(
    document.querySelectorAll<HTMLElement>(UPLOADER),
  )) {
    if (root.dataset.mediaUploadBound === "true") continue;
    root.dataset.mediaUploadBound = "true";
    wireUploader(root);
  }
};

init();
