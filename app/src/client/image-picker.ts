/**
 * The shared image picker.
 *
 * This is the third recorded exception to "the client is presentation only"
 * (AGENTS.md, alongside `cms-form.ts` and the preview guard). A picker is a
 * library the editor searches, pages through and uploads into without leaving
 * the form, so it needs the JSON options route, an XHR with upload progress,
 * and tiles built from the answer. `boundaries.test.ts` allows exactly those
 * three in this file and nowhere else.
 *
 * Two rules keep it from growing into an application. Every piece of markup is
 * built with `createElement` and `textContent` — never `innerHTML` — so data
 * from the server can only become text, never elements. And the only server it
 * talks to is the media routes: `GET /cms/media/options` and
 * `POST /cms/media`; it holds no domain state beyond the page's current pick.
 *
 * With JavaScript off the server-rendered closed field and its hidden input
 * still submit the stored media id unchanged.
 */

import { narrowImageWarning } from "@shared/image-guidance";
import { CSRF_FIELD, CSRF_HEADER } from "@shared/protocol";

/** One page's worth of uploads, as the options route returns them. */
interface PickerOption {
  id: string;
  alt: string;
  width: number;
  height: number;
  /** Null when the upload has no rendition the card can show. */
  thumbnailUrl: string | null;
}

interface OptionsPage {
  items: PickerOption[];
  next: string | null;
}

const isOption = (value: unknown): value is PickerOption => {
  if (typeof value !== "object" || value === null) return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.id === "string" &&
    typeof option.alt === "string" &&
    typeof option.width === "number" &&
    typeof option.height === "number"
  );
};

/**
 * Alt text for a dropped file.
 *
 * The upload handler requires alt text and the drop zone has no per-file box to
 * type it in, so the file's own name — extension stripped, separators to
 * spaces — is the honest starting point. The picker's help line says the
 * editor can refine it on the media page.
 */
const altFromFilename = (filename: string): string => {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base === "" ? "Uploaded image" : base;
};

/** The open picker's own DOM, so the wiring reads once rather than per call. */
interface PickerElements {
  value: HTMLInputElement;
  thumb: HTMLImageElement;
  placeholder: HTMLElement;
  alt: HTMLElement;
  size: HTMLElement;
  choose: HTMLButtonElement;
  remove: HTMLButtonElement;
  modal: HTMLElement;
  dialog: HTMLElement;
  close: HTMLButtonElement;
  drop: HTMLElement;
  file: HTMLInputElement;
  uploads: HTMLElement;
  search: HTMLInputElement;
  grid: HTMLElement;
  status: HTMLElement;
  more: HTMLButtonElement;
}

const must = <T extends Element>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`image picker: no ${selector}`);
  return found;
};

const elementsFor = (root: HTMLElement): PickerElements => ({
  value: must<HTMLInputElement>(root, "[data-image-picker-value]"),
  thumb: must<HTMLImageElement>(root, "[data-image-picker-thumb]"),
  placeholder: must<HTMLElement>(root, "[data-image-picker-thumb-placeholder]"),
  alt: must<HTMLElement>(root, "[data-image-picker-alt]"),
  size: must<HTMLElement>(root, "[data-image-picker-size]"),
  choose: must<HTMLButtonElement>(root, "[data-image-picker-choose]"),
  remove: must<HTMLButtonElement>(root, "[data-image-picker-remove]"),
  modal: must<HTMLElement>(root, "[data-image-picker-modal]"),
  dialog: must<HTMLElement>(root, "[data-picker-dialog]"),
  close: must<HTMLButtonElement>(root, "[data-image-picker-close]"),
  drop: must<HTMLElement>(root, "[data-image-picker-drop]"),
  file: must<HTMLInputElement>(root, "[data-image-picker-file]"),
  uploads: must<HTMLElement>(root, "[data-image-picker-uploads]"),
  search: must<HTMLInputElement>(root, "[data-image-picker-search]"),
  grid: must<HTMLElement>(root, "[data-image-picker-grid]"),
  status: must<HTMLElement>(root, "[data-image-picker-status]"),
  more: must<HTMLButtonElement>(root, "[data-image-picker-more]"),
});

/** A thumbnail tile: an image when there is one, alt text otherwise. */
const thumbnail = (option: PickerOption): HTMLElement => {
  if (option.thumbnailUrl) {
    const image = document.createElement("img");
    image.src = option.thumbnailUrl;
    image.alt = "";
    image.loading = "lazy";
    return image;
  }
  // No usable rendition: a token-coloured tile with the alt text, never a
  // broken `<img>`. This is the correction the approved mock-ups carried.
  const placeholder = document.createElement("span");
  placeholder.className = "cms-picker-placeholder";
  placeholder.textContent = option.alt;
  return placeholder;
};

const optionCard = (
  option: PickerOption,
  selectedId: string,
): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "cms-picker-card";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cms-picker-card-button";
  button.dataset.imagePickerOption = "";
  button.dataset.id = option.id;
  if (option.id === selectedId) button.classList.add("is-selected");

  button.append(thumbnail(option));

  const alt = document.createElement("span");
  alt.className = "cms-picker-card-alt";
  alt.textContent = option.alt;
  button.append(alt);

  const size = document.createElement("span");
  size.className = "cms-picker-card-size";
  size.textContent = `${option.width}×${option.height}`;
  button.append(size);

  item.append(button);
  return item;
};

/** The elements of one upload's tile, so progress and outcome can update it. */
interface UploadTile {
  item: HTMLElement;
  state: HTMLElement;
  bar: HTMLElement;
  preview: HTMLElement;
}

const uploadTile = (file: File): UploadTile => {
  const item = document.createElement("li");
  item.className = "cms-picker-upload";
  item.dataset.state = "uploading";

  const preview = document.createElement("span");
  preview.className = "cms-picker-upload-preview";

  const body = document.createElement("span");
  body.className = "cms-picker-upload-body";

  const name = document.createElement("span");
  name.className = "cms-picker-upload-name";
  name.textContent = file.name;
  body.append(name);

  const progress = document.createElement("span");
  progress.className = "cms-picker-progress";
  const bar = document.createElement("span");
  bar.className = "cms-picker-progress-bar";
  bar.style.width = "0%";
  progress.append(bar);
  body.append(progress);

  const state = document.createElement("span");
  state.className = "cms-picker-upload-state";
  state.textContent = "Uploading…";
  body.append(state);

  item.append(preview, body);
  return { item, state, bar, preview };
};

/** A local preview of a file being uploaded, with the URL to release afterwards. */
interface UploadPreview {
  image: HTMLImageElement;
  url: string;
}

const imagePreview = (file: File): UploadPreview | null => {
  if (typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  return { image, url };
};

/** Release a preview's object URL once the tile shows something else. */
const revokePreview = (preview: UploadPreview | null): void => {
  if (preview && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(preview.url);
  }
};

type UploadResult =
  | { ok: true; option: PickerOption }
  | { ok: false; message: string };

const messageFrom = (body: unknown): string => {
  if (typeof body === "object" && body !== null) {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const first = errors.find(
        (error): error is { message: string } =>
          typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string",
      );
      if (first) return first.message;
    }
  }
  return "Couldn't upload this file.";
};

/** Wire every picker the page rendered. */
const wirePicker = (root: HTMLElement): void => {
  const el = elementsFor(root);
  // Replaced when the server hands back a fresh token after an expired one.
  let token = root.dataset.imagePickerCsrf ?? "";
  const options = new Map<string, PickerOption>();

  let next: string | null = null;
  let query = "";
  let request = 0;
  let lastFocus: HTMLElement | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const selectedId = (): string => el.value.value;

  /**
   * Report the chosen upload's width to the field this picker sits in, and show
   * or clear the too-narrow warning the server rendered a slot for.
   *
   * The field carries `data-image-min-width` from the block metadata and this
   * picker is what knows the width of the upload just chosen: a pick or an
   * upload carries it in the option, and Remove carries none. A page setting's
   * picker has no enclosing `[data-field]`, so it has nowhere to report to and
   * does nothing.
   */
  const reportWidth = (width: number | null): void => {
    const field = root.closest<HTMLElement>("[data-field]");
    if (!field) return;
    if (width === null) delete field.dataset.imageWidth;
    else field.dataset.imageWidth = String(width);

    const warning = field.querySelector<HTMLElement>("[data-image-warning]");
    if (!warning) return;
    const minWidth = Number.parseInt(field.dataset.imageMinWidth ?? "", 10);
    if (
      width === null ||
      !Number.isSafeInteger(minWidth) ||
      width >= minWidth
    ) {
      warning.hidden = true;
      warning.textContent = "";
      return;
    }
    warning.textContent = narrowImageWarning(width, minWidth);
    warning.hidden = false;
  };

  const markSelected = (): void => {
    const id = selectedId();
    for (const card of Array.from(
      el.grid.querySelectorAll<HTMLElement>("[data-image-picker-option]"),
    )) {
      card.classList.toggle("is-selected", card.dataset.id === id);
    }
  };

  /**
   * Draw the closed field from an option (or none).
   *
   * The server renders the same shape; this is what a pick, a remove or an
   * upload changes. A missing thumbnail becomes the placeholder with its alt
   * text — `src` is removed rather than emptied, so no request is made.
   */
  const showChoice = (option: PickerOption | null): void => {
    const before = el.value.value;
    el.value.value = option?.id ?? "";
    if (option) {
      el.alt.textContent = option.alt;
      el.size.textContent = `${option.width}×${option.height}`;
      if (option.thumbnailUrl) {
        el.thumb.src = option.thumbnailUrl;
        el.thumb.hidden = false;
        el.placeholder.hidden = true;
      } else {
        el.thumb.removeAttribute("src");
        el.thumb.hidden = true;
        el.placeholder.hidden = false;
        el.placeholder.textContent = option.alt;
      }
      el.remove.hidden = false;
    } else {
      el.alt.textContent = "No image chosen.";
      el.size.textContent = "";
      el.thumb.removeAttribute("src");
      el.thumb.hidden = true;
      el.placeholder.hidden = false;
      el.placeholder.textContent = "No image";
      el.remove.hidden = true;
    }
    reportWidth(option?.width ?? null);
    markSelected();
    // Setting a hidden input's value fires nothing. The preview guard marks the
    // form dirty from `input` events, so a pick or a remove announces itself
    // the way a typed field would — otherwise Preview would show the old saved
    // draft without asking.
    if (el.value.value !== before) {
      el.value.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  const setStatus = (message: string): void => {
    el.status.textContent = message;
  };

  const setNext = (value: string | null): void => {
    next = value;
    el.more.hidden = value === null;
  };

  const appendOptions = (items: PickerOption[], replace: boolean): void => {
    if (replace) {
      el.grid.replaceChildren();
      options.clear();
    }
    for (const option of items) {
      options.set(option.id, option);
      el.grid.append(optionCard(option, selectedId()));
    }
  };

  const load = async (replace: boolean): Promise<void> => {
    const seq = ++request;
    // A replace is a new query or a fresh open: the previous cursor belongs to
    // rows that query may not have, so Load more must wait for the answer.
    if (replace) setNext(null);
    const params = new URLSearchParams();
    if (query !== "") params.set("q", query);
    if (!replace && next !== null) params.set("after", next);
    setStatus("Loading images…");
    try {
      const response = await fetch(`/cms/media/options?${params.toString()}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("load failed");
      const body: unknown = JSON.parse(await response.text());
      if (seq !== request) return;
      const page = body as OptionsPage;
      const items = Array.isArray(page.items)
        ? page.items.filter(isOption)
        : [];
      appendOptions(items, replace);
      setNext(typeof page.next === "string" ? page.next : null);
      if (options.size === 0) {
        setStatus(
          query === ""
            ? "No images yet. Drop one above to upload it."
            : `No images match "${query}".`,
        );
      } else {
        setStatus("");
      }
    } catch {
      if (seq !== request) return;
      setStatus("Couldn't load the library. Try again.");
    }
  };

  /** A newly uploaded image goes to the front of the grid, whatever the search. */
  const prependOption = (option: PickerOption): void => {
    options.set(option.id, option);
    for (const existing of Array.from(
      el.grid.querySelectorAll<HTMLElement>("[data-image-picker-option]"),
    )) {
      if (existing.dataset.id === option.id) existing.closest("li")?.remove();
    }
    el.grid.prepend(optionCard(option, selectedId()));
    if (el.status.textContent?.startsWith("No images")) setStatus("");
  };

  const focusable = (): HTMLElement[] =>
    Array.from(
      el.dialog.querySelectorAll<HTMLElement>(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => {
      if (element.hasAttribute("disabled") || element.hidden) return false;
      for (
        let parent = element.parentElement;
        parent !== null;
        parent = parent.parentElement
      ) {
        if (parent.hidden) return false;
        if (parent === el.dialog) return true;
      }
      return true;
    });

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function close(): void {
    el.modal.hidden = true;
    document.removeEventListener("keydown", onKeydown);
    const focus = lastFocus ?? el.choose;
    lastFocus = null;
    focus.focus();
  }

  const open = (trigger: HTMLElement): void => {
    lastFocus = trigger;
    el.modal.hidden = false;
    document.addEventListener("keydown", onKeydown);
    el.close.focus();
    void load(true);
  };

  el.choose.addEventListener("click", () => open(el.choose));
  el.close.addEventListener("click", close);
  // Close on a click that both started and ended on the backdrop. A drag-select
  // inside the dialog that is released over the backdrop also fires a click
  // here; remembering where the press began keeps that from closing the dialog.
  let backdropPressed = false;
  el.modal.addEventListener("pointerdown", (event) => {
    backdropPressed = event.target === el.modal;
  });
  el.modal.addEventListener("click", (event) => {
    if (backdropPressed && event.target === el.modal) close();
    backdropPressed = false;
  });

  el.remove.addEventListener("click", () => showChoice(null));

  el.grid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>("[data-image-picker-option]");
    if (!card) return;
    const option = options.get(card.dataset.id ?? "");
    if (!option) return;
    showChoice(option);
    close();
  });

  /** Run a search the editor has typed but the debounce has not fired for. */
  const flushSearch = (): void => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
    const nextQuery = el.search.value.trim();
    if (nextQuery === query) return;
    query = nextQuery;
    void load(true);
  };

  el.more.addEventListener("click", () => {
    // Paging while a search is still pending would pair the new query with the
    // cursor from before it; settle the search first instead.
    if (searchTimer !== undefined || el.search.value.trim() !== query) {
      flushSearch();
      return;
    }
    void load(false);
  });

  el.search.addEventListener("input", (event) => {
    // The picker sits inside the page form. Typing a search is not an edit to
    // the page, so it must not reach the form's dirty listener (preview guard).
    event.stopPropagation();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(flushSearch, 250);
  });

  el.search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    // A search box inside a form submits the whole form on Enter (Save draft /
    // Create page), which would lose the dialog. Search now instead.
    event.preventDefault();
    flushSearch();
  });

  /** Upload one file, updating its tile and resolving to the new option. */
  const upload = async (file: File): Promise<UploadResult> => {
    const tile = uploadTile(file);
    el.uploads.prepend(tile.item);
    const preview = imagePreview(file);
    if (preview) tile.preview.append(preview.image);

    return await new Promise<UploadResult>((resolve) => {
      const send = (csrfToken: string, allowRetry: boolean): void => {
        const form = new FormData();
        form.append(CSRF_FIELD, csrfToken);
        form.append("alt", altFromFilename(file.name));
        form.append("file", file, file.name);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/cms/media");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.setRequestHeader(CSRF_HEADER, csrfToken);

        xhr.upload.addEventListener("progress", (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          tile.bar.style.width = `${percent}%`;
        });

        const fail = (message: string): void => {
          tile.item.dataset.state = "error";
          tile.state.textContent = message;
          // A refused file may not be an image at all, and the object URL's
          // broken-image icon is not a preview. Drop it so the tile shows only
          // the file name and the server's message.
          tile.preview.replaceChildren();
          revokePreview(preview);
          resolve({ ok: false, message });
        };

        xhr.addEventListener("load", () => {
          // The page's upload token can be older than the page by the time the
          // drop zone is used. The server answers an expired-but-authentic
          // token with a fresh one in the CSRF header; spend it once rather
          // than making the editor reload and lose the form.
          if (
            xhr.status === 403 &&
            allowRetry &&
            typeof xhr.getResponseHeader === "function"
          ) {
            const fresh = xhr.getResponseHeader(CSRF_HEADER);
            if (fresh) {
              token = fresh;
              send(fresh, false);
              return;
            }
          }
          let body: unknown = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            body = null;
          }
          if (xhr.status >= 200 && xhr.status < 300 && isOption(body)) {
            const option = body;
            tile.item.dataset.state = "done";
            tile.state.textContent = "Uploaded";
            tile.bar.style.width = "100%";
            if (preview) {
              if (option.thumbnailUrl) {
                preview.image.src = option.thumbnailUrl;
              } else {
                tile.preview.replaceChildren(thumbnail(option));
              }
              // The tile now shows the stored rendition (or the placeholder),
              // so the local blob is no longer needed.
              revokePreview(preview);
            } else {
              tile.preview.append(thumbnail(option));
            }
            resolve({ ok: true, option });
            return;
          }
          fail(messageFrom(body));
        });

        xhr.addEventListener("error", () =>
          fail(
            "Couldn't upload this file. Check the connection and try again.",
          ),
        );

        xhr.send(form);
      };

      send(token, true);
    });
  };

  const uploadFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const single = files.length === 1;
    for (const file of files) {
      const result = await upload(file);
      if (!result.ok) continue;
      prependOption(result.option);
      // One file was dropped: it is the choice, so select it and close. Several
      // files leave the modal open for the editor to pick one. If the editor
      // closed the dialog while the upload ran, leave the field alone — they
      // are no longer looking at it.
      if (single && !el.modal.hidden) {
        showChoice(result.option);
        close();
      }
    }
  };

  el.file.addEventListener("change", (event) => {
    // Choosing a file uploads it to the library; it is not an edit to the page
    // until an upload is selected, which `showChoice` announces.
    event.stopPropagation();
    // Copy before clearing: a browser empties the input's live FileList when
    // `value` is reset, so reading it afterwards would upload nothing. This
    // was caught in Chromium after the unit tests passed on a static array.
    const files = Array.from(el.file.files ?? []);
    el.file.value = "";
    void uploadFiles(files);
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
    void uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  // A stored image's width came down with the picker, so report it now: the
  // too-narrow warning has to be beside the field on load, not only after the
  // editor picks the same image again. A page setting's picker has no enclosing
  // field and `reportWidth` does nothing there.
  const initialWidth = Number.parseInt(root.dataset.imagePickerWidth ?? "", 10);
  if (Number.isSafeInteger(initialWidth)) reportWidth(initialWidth);

  markSelected();
};

const PICKER_FIELD = "[data-image-picker-field]";

/**
 * Bind every closed field on the page.
 *
 * Marked once, so a test that calls `init` after the module's own run does not
 * double-bind the same field (two click handlers would open two dialogs).
 */
export const init = (): void => {
  for (const root of Array.from(
    document.querySelectorAll<HTMLElement>(PICKER_FIELD),
  )) {
    if (root.dataset.imagePickerBound === "true") continue;
    root.dataset.imagePickerBound = "true";
    wirePicker(root);
  }
};

/**
 * Bind pickers that arrive after this module ran.
 *
 * A list row or block is cloned from a `<template>` and inserted later, and
 * the module's one run at load cannot see it; without this its Choose button
 * would do nothing. Watching the document rather than hooking the editor's
 * clone sites means every insertion path is covered, including one a later
 * change adds. `init` is idempotent, so this only costs a query per insertion.
 */
const watchForPickers = (): void => {
  if (typeof MutationObserver !== "function") return;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(PICKER_FIELD) || node.querySelector(PICKER_FIELD)) {
          init();
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
};

init();
watchForPickers();
