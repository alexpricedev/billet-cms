import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_ALT_LENGTH as CONTRACT_MAX_ALT_LENGTH,
  MAX_UPLOAD_BYTES as CONTRACT_MAX_UPLOAD_BYTES,
} from "@alexpricedev/billet-cms/contract";
import {
  init,
  MAX_ALT_LENGTH,
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPES,
  UPLOADED_TILE_LINGER_MS,
} from "./media-upload";

/**
 * The Media page's uploader, as `MediaList` renders it. Only the elements the
 * client reads are here; the test is about wiring, not markup.
 */
const markup = `
  <section data-media-upload data-media-upload-csrf="upload-token">
    <div data-media-drop>
      <p>Drop images here, or choose a file.</p>
      <label>
        Choose file
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple data-media-file>
      </label>
      <p class="cms-field-help">JPEG, PNG or WebP up to 20 MB.</p>
    </div>
    <button type="button" data-media-upload-all hidden>Upload all</button>
    <ul data-media-staged></ul>
  </section>
  <p data-media-empty>No images yet</p>
  <ul data-media-grid></ul>
`;

const OPTION = {
  id: "11111111-1111-4111-8111-111111111111",
  alt: "A pier at dusk",
  width: 1600,
  height: 900,
  thumbnailUrl: "https://cdn.example.test/pier-192.webp",
};
const SECOND_OPTION = {
  id: "22222222-2222-4222-8222-222222222222",
  alt: "A second upload",
  width: 800,
  height: 600,
  thumbnailUrl: null,
};

const el = {
  root: (): HTMLElement =>
    document.querySelector("[data-media-upload]") as HTMLElement,
  drop: (): HTMLElement =>
    document.querySelector("[data-media-drop]") as HTMLElement,
  file: (): HTMLInputElement =>
    document.querySelector("[data-media-file]") as HTMLInputElement,
  uploadAll: (): HTMLButtonElement =>
    document.querySelector("[data-media-upload-all]") as HTMLButtonElement,
  staged: (): HTMLElement =>
    document.querySelector("[data-media-staged]") as HTMLElement,
  grid: (): HTMLElement =>
    document.querySelector("[data-media-grid]") as HTMLElement,
  empty: (): HTMLElement =>
    document.querySelector("[data-media-empty]") as HTMLElement,
};

const tiles = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-media-tile]"));
const tile = (index: number): HTMLElement => tiles()[index] as HTMLElement;
const alt = (index: number): HTMLInputElement =>
  tile(index).querySelector<HTMLInputElement>(
    "[data-media-alt]",
  ) as HTMLInputElement;
const upload = (index: number): HTMLButtonElement =>
  tile(index).querySelector<HTMLButtonElement>(
    "[data-media-tile-upload]",
  ) as HTMLButtonElement;
const remove = (index: number): HTMLButtonElement =>
  tile(index).querySelector<HTMLButtonElement>(
    "[data-media-tile-remove]",
  ) as HTMLButtonElement;
const error = (index: number): HTMLElement =>
  tile(index).querySelector<HTMLElement>("[data-media-error]") as HTMLElement;
const bar = (index: number): HTMLElement =>
  tile(index).querySelector<HTMLElement>("[data-media-bar]") as HTMLElement;
const progress = (index: number): HTMLElement =>
  tile(index).querySelector<HTMLElement>(
    "[data-media-progress]",
  ) as HTMLElement;
const state = (index: number): HTMLElement =>
  tile(index).querySelector<HTMLElement>("[data-media-state]") as HTMLElement;

/** Replace the page with the uploader and wire it, as the bundle would. */
const mount = (html = markup): void => {
  document.body.innerHTML = html;
  init();
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const typeAlt = (index: number, value: string): void => {
  const input = alt(index);
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

/**
 * Choose files the way a browser does: the FileList is a live view, and
 * resetting the input's `value` empties it. The client has to copy the list
 * before clearing the input or a real Chromium stages nothing.
 */
const setFiles = (files: File[]): void => {
  const input = el.file();
  let current: File[] | null = files;
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () =>
      ({
        [Symbol.iterator]: () =>
          (current ?? [])[Symbol.iterator]() as IterableIterator<File>,
      }) as unknown as FileList,
  });
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => "",
    set: () => {
      current = null;
    },
  });
  input.dispatchEvent(new Event("change"));
};

const dropFiles = (files: File[]): void => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  el.drop().dispatchEvent(event);
};

const image = (name: string, type = "image/png", bytes = 3): File =>
  new File([new Uint8Array(bytes)], name, { type });

const leavePrompted = (): boolean => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

type FakeResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
const uploads: FakeResponse[] = [];

class FakeXhr {
  static last: FakeXhr | null = null;
  static instances: FakeXhr[] = [];
  status = 0;
  responseText = "";
  sent: FormData | null = null;
  private uploadListeners = new Map<
    string,
    (event: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void
  >();
  upload = {
    addEventListener: (
      type: string,
      handler: (event: {
        lengthComputable: boolean;
        loaded: number;
        total: number;
      }) => void,
    ): void => {
      this.uploadListeners.set(type, handler);
    },
  };
  private responseHeaders: Record<string, string> = {};
  private listeners = new Map<string, () => void>();

  constructor() {
    FakeXhr.last = this;
    FakeXhr.instances.push(this);
  }
  open(): void {}
  setRequestHeader(): void {}
  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, handler);
  }
  progress(percent: number): void {
    this.uploadListeners.get("progress")?.({
      lengthComputable: true,
      loaded: percent,
      total: 100,
    });
  }
  send(form: FormData): void {
    this.sent = form;
    const answer = uploads.shift() ?? { status: 500, body: null };
    setTimeout(() => {
      this.status = answer.status;
      this.responseText = JSON.stringify(answer.body);
      this.responseHeaders = Object.fromEntries(
        Object.entries(answer.headers ?? {}).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      );
      this.listeners.get("load")?.();
    }, 0);
  }
}

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
const originalMatchMedia = window.matchMedia;
let reduceMotion = true;

beforeEach(() => {
  uploads.length = 0;
  FakeXhr.last = null;
  FakeXhr.instances = [];
  reduceMotion = true;
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => JSON.stringify({ items: [], next: null }),
  })) as unknown as typeof fetch;
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  mount();
});

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
  if (originalMatchMedia === undefined) {
    Reflect.deleteProperty(window, "matchMedia");
  } else {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  }
});

describe("media page uploader", () => {
  // The client repeats the limits so the browser can refuse a file before it
  // is sent; the contract's numbers are the source of truth.
  test("the browser's copy of the limits matches the contract", () => {
    expect(UPLOAD_TYPES).toEqual([...ALLOWED_UPLOAD_TYPES]);
    expect(MAX_UPLOAD_BYTES).toBe(CONTRACT_MAX_UPLOAD_BYTES);
    expect(MAX_ALT_LENGTH).toBe(CONTRACT_MAX_ALT_LENGTH);
  });

  test("staging files does not upload them", () => {
    setFiles([image("one.png"), image("two.png")]);

    expect(FakeXhr.instances).toHaveLength(0);
    expect(tiles()).toHaveLength(2);
    expect(tile(0).textContent).toContain("one.png");
    expect(tile(0).dataset.state).toBe("staged");
    expect(el.uploadAll().hidden).toBe(false);
  });

  test("a dropped file is staged the same way as a chosen one", () => {
    dropFiles([image("one.png")]);

    expect(FakeXhr.instances).toHaveLength(0);
    expect(tiles()).toHaveLength(1);
    expect(tile(0).textContent).toContain("one.png");
  });

  test("the first tile gets focus and shows its name and size", () => {
    setFiles([image("one.png", "image/png", 2048), image("two.png")]);

    expect(document.activeElement).toBe(alt(0));
    expect(tile(0).textContent).toContain("one.png");
    expect(tile(0).textContent).toContain("2 KB");
    expect(alt(0).maxLength).toBe(1000);
  });

  test("Upload stays disabled until the tile has alt text", () => {
    setFiles([image("one.png")]);

    expect(upload(0).disabled).toBe(true);
    typeAlt(0, "   ");
    expect(upload(0).disabled).toBe(true);
    typeAlt(0, "A pier at dusk");
    expect(upload(0).disabled).toBe(false);
  });

  test("a single tile has no Upload all", () => {
    setFiles([image("one.png")]);

    expect(el.uploadAll().hidden).toBe(true);
  });

  test("Upload all shows for several tiles and waits for every alt", () => {
    setFiles([image("one.png"), image("two.png")]);

    expect(el.uploadAll().hidden).toBe(false);
    expect(el.uploadAll().disabled).toBe(true);

    typeAlt(0, "One");
    expect(el.uploadAll().disabled).toBe(true);

    typeAlt(1, "Two");
    expect(el.uploadAll().disabled).toBe(false);
  });

  test("a file the browser can already refuse says why and cannot upload", () => {
    const tooBig = image("huge.png");
    Object.defineProperty(tooBig, "size", {
      configurable: true,
      value: MAX_UPLOAD_BYTES + 1,
    });
    setFiles([image("notes.txt", "text/plain"), tooBig]);

    expect(FakeXhr.instances).toHaveLength(0);
    expect(tile(0).dataset.invalid).toBe("true");
    expect(tile(0).dataset.state).toBe("error");
    expect(error(0).textContent).toContain("JPEG, PNG or WebP");
    expect(alt(0).disabled).toBe(true);
    expect(upload(0).disabled).toBe(true);

    expect(tile(1).dataset.invalid).toBe("true");
    expect(error(1).textContent).toContain("larger than 20 MB");
    expect(upload(1).disabled).toBe(true);

    upload(0).click();
    expect(FakeXhr.instances).toHaveLength(0);
  });

  test("a file with no declared type is left for the server to sniff", () => {
    setFiles([image("mystery", "")]);

    expect(tile(0).dataset.invalid).toBeUndefined();
    typeAlt(0, "Something");
    expect(upload(0).disabled).toBe(false);
  });

  test("Enter in the alt input uploads that tile", async () => {
    setFiles([image("one.png")]);
    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    alt(0).dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0]?.sent?.get("alt")).toBe("A pier at dusk");
    expect(FakeXhr.instances[0]?.sent?.get("_csrf")).toBe("upload-token");
  });

  test("Enter that confirms an IME composition does not upload", () => {
    setFiles([image("one.png")]);
    typeAlt(0, "ピア");

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { value: true });
    alt(0).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  test("Remove drops a staged file and releases its preview", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const url = `blob:preview-${created.length}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      setFiles([image("one.png"), image("two.png")]);
      remove(0).click();

      expect(tiles()).toHaveLength(1);
      expect(tile(0).textContent).toContain("two.png");
      expect(revoked).toEqual([created[0]]);
      expect(el.uploadAll().hidden).toBe(true);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("an upload reports progress and locks the tile while it sends", async () => {
    setFiles([image("one.png")]);
    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });

    upload(0).click();
    FakeXhr.last?.progress(42);

    expect(tile(0).dataset.state).toBe("uploading");
    expect(progress(0).hidden).toBe(false);
    expect(bar(0).style.width).toBe("42%");
    expect(alt(0).disabled).toBe(true);
    expect(upload(0).disabled).toBe(true);
    expect(remove(0).disabled).toBe(true);
    expect(state(0).textContent).toBe("Uploading…");

    await flush();
  });

  test("a successful upload adds a card to the front of the grid", async () => {
    const existing = document.createElement("li");
    existing.className = "cms-media-card";
    existing.dataset.existing = "";
    existing.textContent = "Older upload";
    el.grid().append(existing);

    setFiles([image("one.png")]);
    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });
    upload(0).click();
    await flush();

    const first = el.grid().firstElementChild as HTMLElement;
    expect(first.dataset.mediaCard).toBe("");
    expect(first.querySelector("a")?.getAttribute("href")).toBe(
      `/cms/media/${OPTION.id}`,
    );
    expect(first.querySelector("img")?.getAttribute("src")).toBe(
      OPTION.thumbnailUrl,
    );
    expect(first.querySelector(".cms-media-alt")?.textContent).toBe(OPTION.alt);
    expect(first.textContent).toContain("1600×900");
    expect(el.grid().children[1]).toBe(existing);
    expect(el.empty().hidden).toBe(true);

    // Reduced motion: the finished tile leaves at once rather than lingering.
    expect(tiles()).toHaveLength(0);
    expect(el.uploadAll().hidden).toBe(true);
  });

  test("an uploaded tile lingers with Uploaded, then clears itself", async () => {
    reduceMotion = false;
    setFiles([image("one.png")]);
    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });

    upload(0).click();
    await flush();

    expect(tile(0).dataset.state).toBe("done");
    expect(state(0).textContent).toBe("Uploaded");
    expect(tiles()).toHaveLength(1);

    await wait(UPLOADED_TILE_LINGER_MS + 60);
    expect(tiles()).toHaveLength(0);
  });

  test("a server error keeps the file and alt text, and a retry succeeds", async () => {
    setFiles([image("one.png")]);
    typeAlt(0, "A pier at dusk");
    uploads.push({
      status: 400,
      body: {
        errors: [{ field: "file", message: "That image is too large." }],
      },
    });
    upload(0).click();
    await flush();

    expect(tile(0).dataset.state).toBe("error");
    expect(error(0).hidden).toBe(false);
    expect(error(0).textContent).toBe("That image is too large.");
    expect(alt(0).value).toBe("A pier at dusk");
    expect(alt(0).disabled).toBe(false);
    expect(upload(0).disabled).toBe(false);
    expect(tiles()).toHaveLength(1);
    expect(el.grid().children).toHaveLength(0);

    uploads.push({ status: 200, body: OPTION });
    upload(0).click();
    await flush();

    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.instances[1]?.sent?.get("alt")).toBe("A pier at dusk");
    expect(el.grid().children).toHaveLength(1);
    expect(tiles()).toHaveLength(0);
  });

  test("Upload all is disabled while a single tile uploads, then refreshed", async () => {
    setFiles([image("one.png"), image("two.png")]);
    typeAlt(0, "One");
    typeAlt(1, "Two");
    uploads.push({
      status: 400,
      body: {
        errors: [{ field: "file", message: "That image is too large." }],
      },
    });

    upload(0).click();
    expect(tile(0).dataset.state).toBe("uploading");
    expect(el.uploadAll().disabled).toBe(true);

    await flush();
    // The refused tile keeps a retry, so the batch is offered again.
    expect(tile(0).dataset.state).toBe("error");
    expect(el.uploadAll().disabled).toBe(false);

    uploads.push(
      { status: 200, body: OPTION },
      { status: 200, body: SECOND_OPTION },
    );
    el.uploadAll().click();
    await flush();

    expect(FakeXhr.instances).toHaveLength(3);
  });

  test("Upload all sends every staged tile, in order", async () => {
    setFiles([image("one.png"), image("two.png")]);
    typeAlt(0, "One");
    typeAlt(1, "Two");
    uploads.push(
      { status: 200, body: OPTION },
      { status: 200, body: SECOND_OPTION },
    );

    el.uploadAll().click();
    await flush();

    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.instances.map((xhr) => xhr.sent?.get("alt"))).toEqual([
      "One",
      "Two",
    ]);
    // Each card is prepended as it lands, so the newest is first; both tiles
    // then clear themselves.
    expect(el.grid().children).toHaveLength(2);
    expect(
      (el.grid().firstElementChild as HTMLElement).querySelector(
        ".cms-media-alt",
      )?.textContent,
    ).toBe(SECOND_OPTION.alt);
    expect(tiles()).toHaveLength(0);
    expect(el.uploadAll().hidden).toBe(true);
  });

  test("a fresh token from an expired one is used for the next tile", async () => {
    setFiles([image("one.png"), image("two.png")]);
    typeAlt(0, "One");
    typeAlt(1, "Two");
    uploads.push(
      {
        status: 403,
        body: { errors: [{ message: "This page expired." }] },
        headers: { "X-CSRF-Token": "fresh-token" },
      },
      { status: 200, body: OPTION },
      { status: 200, body: SECOND_OPTION },
    );

    el.uploadAll().click();
    await flush();

    expect(FakeXhr.instances).toHaveLength(3);
    expect(FakeXhr.instances.map((xhr) => xhr.sent?.get("_csrf"))).toEqual([
      "upload-token",
      "fresh-token",
      "fresh-token",
    ]);
  });

  test("the leave prompt appears only while tiles are unsent", async () => {
    expect(leavePrompted()).toBe(false);

    setFiles([image("one.png")]);
    expect(leavePrompted()).toBe(true);

    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });
    upload(0).click();
    await flush();
    expect(leavePrompted()).toBe(false);

    setFiles([image("two.png")]);
    expect(leavePrompted()).toBe(true);
    remove(0).click();
    expect(leavePrompted()).toBe(false);
  });

  test("a file the browser refused does not keep the leave prompt up", async () => {
    const tooBig = image("huge.png");
    Object.defineProperty(tooBig, "size", {
      configurable: true,
      value: MAX_UPLOAD_BYTES + 1,
    });
    setFiles([image("one.png"), tooBig]);
    expect(leavePrompted()).toBe(true);

    typeAlt(0, "A pier at dusk");
    uploads.push({ status: 200, body: OPTION });
    upload(0).click();
    await flush();

    // The valid tile uploaded and cleared itself; only the refused file is
    // left, and it can never be sent, so leaving would lose nothing.
    expect(tiles()).toHaveLength(1);
    expect(tile(0).dataset.invalid).toBe("true");
    expect(leavePrompted()).toBe(false);
  });
});
