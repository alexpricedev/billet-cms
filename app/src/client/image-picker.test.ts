import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { init } from "./image-picker";

/**
 * One server-rendered picker, as `ImagePicker` writes it. Only the elements the
 * client reads are here; the client test is about wiring, not markup.
 */
const pickerField = (width?: number): string => `
    <fieldset class="cms-field cms-image-picker"
      data-image-picker-field
      data-image-picker-csrf="upload-token"
      data-image-picker-name="socialImageId"${
        width === undefined ? "" : ` data-image-picker-width="${width}"`
      }>
      <input type="hidden" name="socialImageId" value="" data-image-picker-value>
      <div data-image-picker-current>
        <img class="cms-image-picker-thumb" data-image-picker-thumb alt="" hidden>
        <span data-image-picker-thumb-placeholder hidden>No image</span>
        <span data-image-picker-alt>No image chosen.</span>
        <span data-image-picker-size></span>
      </div>
      <button type="button" data-image-picker-choose>Choose image</button>
      <button type="button" data-image-picker-remove hidden>Remove</button>
      <div data-image-picker-modal hidden>
        <div data-picker-dialog role="dialog" aria-modal="true">
          <button type="button" data-image-picker-close>Close</button>
          <div data-image-picker-drop>
            <input type="file" multiple data-image-picker-file>
          </div>
          <ul data-image-picker-uploads></ul>
          <input type="search" data-image-picker-search>
          <ul data-image-picker-grid></ul>
          <p role="status" data-image-picker-status></p>
          <button type="button" data-image-picker-more hidden>Load more</button>
        </div>
      </div>
    </fieldset>
`;

const markup = `
  <form>
    ${pickerField()}
  </form>
`;

const FIRST = {
  id: "11111111-1111-4111-8111-111111111111",
  alt: "A pier at dusk",
  width: 1600,
  height: 900,
  thumbnailUrl: "https://cdn.example.test/pier-192.webp",
};
const SECOND = {
  id: "22222222-2222-4222-8222-222222222222",
  alt: "An upload with no rendition",
  width: 800,
  height: 600,
  thumbnailUrl: null,
};
const THIRD = {
  id: "33333333-3333-4333-8333-333333333333",
  alt: "Third",
  width: 100,
  height: 100,
  thumbnailUrl: "https://cdn.example.test/third-192.webp",
};

const el = {
  root: (): HTMLElement =>
    document.querySelector("[data-image-picker-field]") as HTMLElement,
  value: (): HTMLInputElement =>
    document.querySelector("[data-image-picker-value]") as HTMLInputElement,
  alt: (): HTMLElement =>
    document.querySelector("[data-image-picker-alt]") as HTMLElement,
  size: (): HTMLElement =>
    document.querySelector("[data-image-picker-size]") as HTMLElement,
  thumb: (): HTMLImageElement =>
    document.querySelector("[data-image-picker-thumb]") as HTMLImageElement,
  placeholder: (): HTMLElement =>
    document.querySelector(
      "[data-image-picker-thumb-placeholder]",
    ) as HTMLElement,
  choose: (): HTMLButtonElement =>
    document.querySelector("[data-image-picker-choose]") as HTMLButtonElement,
  remove: (): HTMLButtonElement =>
    document.querySelector("[data-image-picker-remove]") as HTMLButtonElement,
  modal: (): HTMLElement =>
    document.querySelector("[data-image-picker-modal]") as HTMLElement,
  close: (): HTMLButtonElement =>
    document.querySelector("[data-image-picker-close]") as HTMLButtonElement,
  file: (): HTMLInputElement =>
    document.querySelector("[data-image-picker-file]") as HTMLInputElement,
  uploads: (): HTMLElement =>
    document.querySelector("[data-image-picker-uploads]") as HTMLElement,
  search: (): HTMLInputElement =>
    document.querySelector("[data-image-picker-search]") as HTMLInputElement,
  grid: (): HTMLElement =>
    document.querySelector("[data-image-picker-grid]") as HTMLElement,
  status: (): HTMLElement =>
    document.querySelector("[data-image-picker-status]") as HTMLElement,
  more: (): HTMLButtonElement =>
    document.querySelector("[data-image-picker-more]") as HTMLButtonElement,
};

const cards = (): HTMLElement[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>("[data-image-picker-option]"),
  );

/** Replace the page with the picker and wire it, as the bundle would. */
const mount = (html = markup): void => {
  document.body.innerHTML = html;
  init();
};

/** A picker inside the `[data-field]` an image field renders around it. */
const mountInField = (minWidth?: number, width?: number): void => {
  mount(`
    <form>
      <div data-field data-field-kind="image" data-field-name="photo"${
        minWidth === undefined ? "" : ` data-image-min-width="${minWidth}"`
      }>
        ${pickerField(width)}
        <p class="cms-field-warning" data-image-warning hidden></p>
      </div>
    </form>
  `);
};

const warning = (): HTMLElement =>
  document.querySelector("[data-image-warning]") as HTMLElement;

const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const press = (key: string, shiftKey = false): void => {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
  );
};

type OptionsPage = {
  items: readonly unknown[];
  next: string | null;
};

const requested: string[] = [];
let pages: OptionsPage[] = [];

const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : String(input);
  requested.push(url);
  const page = pages.shift() ?? { items: [], next: null };
  // The client only reads `ok` and `text`; a real Response is not needed and
  // happy-dom's enforces same-origin on construction.
  return {
    ok: true,
    text: async () => JSON.stringify(page),
  } as Response;
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
  upload = { addEventListener: (): void => undefined };
  status = 0;
  responseText = "";
  sent: FormData | null = null;
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

beforeEach(() => {
  requested.length = 0;
  pages = [];
  uploads.length = 0;
  FakeXhr.last = null;
  FakeXhr.instances = [];
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  mount();
});

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
});

const open = async (page: OptionsPage): Promise<void> => {
  pages = [page];
  el.choose().click();
  await flush();
};

/**
 * Choose files the way a browser does: the FileList is a live view, and
 * resetting the input's `value` empties it. The client has to copy the list
 * before clearing the input or a real Chromium uploads nothing.
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

const image = (name: string): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("image picker", () => {
  test("opening asks for the newest page and renders a card for each", async () => {
    await open({ items: [FIRST, SECOND], next: null });

    expect(requested).toEqual(["/cms/media/options?"]);
    expect(cards()).toHaveLength(2);
    expect(cards()[0]?.textContent).toContain(FIRST.alt);
    expect(cards()[0]?.textContent).toContain("1600×900");
    expect(cards()[0]?.querySelector("img")?.getAttribute("src")).toBe(
      FIRST.thumbnailUrl,
    );
    expect(el.modal().hidden).toBe(false);
    expect(el.more().hidden).toBe(true);
    expect(el.status().textContent).toBe("");
  });

  // The mock-up correction: no rendition means a placeholder carrying the alt
  // text, never a broken `<img>`.
  test("draws an option with no thumbnail as a placeholder, not an image", async () => {
    await open({ items: [SECOND], next: null });
    const card = cards()[0];

    expect(card?.querySelector("img")).toBeNull();
    const placeholder = card?.querySelector(".cms-picker-placeholder");
    expect(placeholder?.textContent).toBe(SECOND.alt);
  });

  test("shows the empty library state", async () => {
    await open({ items: [], next: null });

    expect(cards()).toHaveLength(0);
    expect(el.status().textContent).toContain("No images yet");
  });

  test("picking a card fills the field, closes and returns focus to Choose", async () => {
    await open({ items: [FIRST], next: null });
    cards()[0]?.click();

    expect(el.value().value).toBe(FIRST.id);
    expect(el.alt().textContent).toBe(FIRST.alt);
    expect(el.size().textContent).toBe("1600×900");
    expect(el.thumb().getAttribute("src")).toBe(FIRST.thumbnailUrl);
    expect(el.thumb().hidden).toBe(false);
    expect(el.placeholder().hidden).toBe(true);
    expect(el.remove().hidden).toBe(false);
    expect(el.modal().hidden).toBe(true);
    expect(document.activeElement).toBe(el.choose());
  });

  test("picking an option with no thumbnail swaps in the placeholder", async () => {
    await open({ items: [SECOND], next: null });
    cards()[0]?.click();

    expect(el.value().value).toBe(SECOND.id);
    expect(el.thumb().hidden).toBe(true);
    expect(el.thumb().hasAttribute("src")).toBe(false);
    expect(el.placeholder().hidden).toBe(false);
    expect(el.placeholder().textContent).toBe(SECOND.alt);
  });

  test("Remove clears the field and hides itself", () => {
    el.value().value = FIRST.id;
    el.remove().hidden = false;
    el.remove().click();

    expect(el.value().value).toBe("");
    expect(el.alt().textContent).toBe("No image chosen.");
    expect(el.size().textContent).toBe("");
    expect(el.thumb().hasAttribute("src")).toBe(false);
    expect(el.placeholder().hidden).toBe(false);
    expect(el.placeholder().textContent).toBe("No image");
    expect(el.remove().hidden).toBe(true);
  });

  test("Escape closes the dialog and returns focus to the trigger", async () => {
    await open({ items: [FIRST], next: null });
    expect(document.activeElement).toBe(el.close());

    press("Escape");

    expect(el.modal().hidden).toBe(true);
    expect(document.activeElement).toBe(el.choose());
  });

  test("Tab wraps inside the dialog in both directions", async () => {
    await open({ items: [], next: null });
    // Close, the file input and search are the only visible controls; Load
    // more is hidden, so search is last.
    el.search().focus();
    press("Tab");
    expect(document.activeElement).toBe(el.close());

    el.close().focus();
    press("Tab", true);
    expect(document.activeElement).toBe(el.search());
  });

  test("a single upload is selected and closes the picker", async () => {
    await open({ items: [], next: null });
    uploads.push({ status: 200, body: FIRST });
    setFiles([image("pier_at_dusk.png")]);
    await flush();

    const form = FakeXhr.last?.sent;
    expect(form?.get("_csrf")).toBe("upload-token");
    // The drop zone has no alt box, so the file name is the starting alt.
    expect(form?.get("alt")).toBe("pier at dusk");

    expect(el.value().value).toBe(FIRST.id);
    expect(el.alt().textContent).toBe(FIRST.alt);
    expect(el.modal().hidden).toBe(true);
    const tile = el.uploads().querySelector<HTMLElement>("[data-state]");
    expect(tile?.dataset.state).toBe("done");
    expect(tile?.textContent).toContain("Uploaded");
  });

  test("several uploads stay open and land at the front of the grid", async () => {
    await open({ items: [THIRD], next: null });
    uploads.push({ status: 200, body: FIRST }, { status: 200, body: SECOND });
    setFiles([image("one.png"), image("two.png")]);
    await flush();

    expect(el.modal().hidden).toBe(false);
    expect(el.value().value).toBe("");
    // Each upload is prepended as it finishes, so the grid stays newest-first.
    expect(cards().map((card) => card.dataset.id)).toEqual([
      SECOND.id,
      FIRST.id,
      THIRD.id,
    ]);
  });

  test("an upload the server refuses shows its message on the tile", async () => {
    // Give the upload a local preview, as a browser would, so the test proves
    // a refusal also removes the broken-image icon it would otherwise draw.
    const original = URL.createObjectURL;
    URL.createObjectURL = () => "blob:preview";
    try {
      await open({ items: [], next: null });
      uploads.push({
        status: 400,
        body: {
          errors: [{ field: "file", message: "That image is too large." }],
        },
      });
      setFiles([image("huge.png")]);
      await flush();

      const tile = el.uploads().querySelector<HTMLElement>("[data-state]");
      expect(tile?.dataset.state).toBe("error");
      expect(tile?.textContent).toContain("That image is too large.");
      expect(tile?.querySelector("img")).toBeNull();
      // A failure is not a pick: the field is untouched and the modal is open.
      expect(el.value().value).toBe("");
      expect(el.modal().hidden).toBe(false);
    } finally {
      URL.createObjectURL = original;
    }
  });

  test("Load more asks for the next page and appends it", async () => {
    pages = [
      { items: [FIRST], next: "cursor-1" },
      { items: [SECOND], next: null },
    ];
    el.choose().click();
    await flush();
    expect(el.more().hidden).toBe(false);

    el.more().click();
    await flush();

    expect(requested[1]).toBe("/cms/media/options?after=cursor-1");
    expect(cards()).toHaveLength(2);
    expect(el.more().hidden).toBe(true);
  });

  test("typing in search refetches with the query after a pause", async () => {
    pages = [
      { items: [FIRST], next: null },
      { items: [FIRST], next: null },
    ];
    el.choose().click();
    await flush();

    el.search().value = "pier";
    el.search().dispatchEvent(new Event("input"));
    // The debounce is 250ms; nothing is requested before it elapses.
    expect(requested).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(requested[1]).toBe("/cms/media/options?q=pier");
    expect(cards()).toHaveLength(1);
  });

  test("a failed load says so rather than leaving the grid blank", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      text: async () => "",
    })) as unknown as typeof fetch;

    el.choose().click();
    await flush();

    expect(el.status().textContent).toBe(
      "Couldn't load the library. Try again.",
    );
  });

  test("the empty state names a search that matched nothing", async () => {
    pages = [
      { items: [FIRST], next: null },
      { items: [], next: null },
    ];
    el.choose().click();
    await flush();

    el.search().value = "nothing";
    el.search().dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(el.status().textContent).toBe('No images match "nothing".');
  });

  test("Enter in search searches instead of submitting the page form", async () => {
    pages = [
      { items: [FIRST], next: null },
      { items: [], next: null },
    ];
    el.choose().click();
    await flush();

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    el.search().value = "pier";
    el.search().dispatchEvent(event);
    await flush();

    // The search box lives inside the page form; its Enter must not save.
    expect(event.defaultPrevented).toBe(true);
    expect(requested[1]).toBe("/cms/media/options?q=pier");
  });

  test("a pick marks the form dirty, but searching and choosing a file do not", async () => {
    await open({ items: [FIRST], next: null });
    const form = document.querySelector("form") as HTMLFormElement;
    let dirty = 0;
    const onInput = (): void => {
      dirty += 1;
    };
    form.addEventListener("input", onInput);
    form.addEventListener("change", onInput);

    try {
      el.search().value = "pier";
      el.search().dispatchEvent(new Event("input", { bubbles: true }));
      el.file().dispatchEvent(new Event("change", { bubbles: true }));
      expect(dirty).toBe(0);

      cards()[0]?.click();
      expect(dirty).toBe(1);

      el.remove().click();
      expect(dirty).toBe(2);
    } finally {
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onInput);
    }
  });

  test("Load more settles a pending search rather than paging the old query", async () => {
    pages = [
      { items: [FIRST], next: "cursor-1" },
      { items: [], next: null },
    ];
    el.choose().click();
    await flush();
    expect(el.more().hidden).toBe(false);

    el.search().value = "pier";
    el.search().dispatchEvent(new Event("input", { bubbles: true }));
    // Before the debounce fires, the cursor still belongs to the old query.
    el.more().click();
    await flush();

    expect(requested[1]).toBe("/cms/media/options?q=pier");
  });

  test("releases the local preview once the upload finishes", async () => {
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:preview";
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      await open({ items: [], next: null });
      uploads.push({ status: 200, body: FIRST });
      setFiles([image("one.png")]);
      await flush();

      expect(revoked).toEqual(["blob:preview"]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("an upload that lands after the dialog closed leaves the field alone", async () => {
    await open({ items: [], next: null });
    uploads.push({ status: 200, body: FIRST });
    setFiles([image("one.png")]);
    // The fake XHR answers on a 0ms timer; close first.
    el.close().click();
    await flush();

    expect(el.modal().hidden).toBe(true);
    expect(el.value().value).toBe("");
  });

  test("an expired upload token is refreshed and the upload retried once", async () => {
    await open({ items: [], next: null });
    uploads.push(
      {
        status: 403,
        body: { errors: [{ message: "This page expired." }] },
        headers: { "X-CSRF-Token": "fresh-token" },
      },
      { status: 200, body: FIRST },
    );
    setFiles([image("one.png")]);
    await flush();

    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.instances[0]?.sent?.get("_csrf")).toBe("upload-token");
    expect(FakeXhr.instances[1]?.sent?.get("_csrf")).toBe("fresh-token");
    expect(el.value().value).toBe(FIRST.id);
  });

  test("a selection drag released over the backdrop does not close the dialog", async () => {
    await open({ items: [], next: null });

    const dialog = document.querySelector(
      "[data-picker-dialog]",
    ) as HTMLElement;
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    el.modal().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.modal().hidden).toBe(false);

    // A press that starts on the backdrop itself still closes.
    el.modal().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    el.modal().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.modal().hidden).toBe(true);
  });

  // The min-width warning used to be worked out from a <select> option's
  // `data-media-width`; the picker itself knows the width of the upload it drew.
  test("reports the picked width and warns when it is under the field's minimum", async () => {
    mountInField(1600);
    await open({ items: [SECOND], next: null });
    cards()[0]?.click();

    const field = document.querySelector<HTMLElement>("[data-field]");
    expect(field?.dataset.imageWidth).toBe("800");
    expect(warning().hidden).toBe(false);
    expect(warning().textContent).toContain("800px");
    expect(warning().textContent).toContain("1600px");
  });

  test("a wide pick clears the warning, and Remove clears it again", async () => {
    mountInField(1600);
    await open({ items: [SECOND], next: null });
    cards()[0]?.click();
    expect(warning().hidden).toBe(false);

    await open({ items: [FIRST], next: null });
    cards()[0]?.click();
    expect(warning().hidden).toBe(true);
    expect(warning().textContent).toBe("");

    el.remove().click();
    const field = document.querySelector<HTMLElement>("[data-field]");
    expect(field?.dataset.imageWidth).toBeUndefined();
    expect(warning().hidden).toBe(true);
    expect(warning().textContent).toBe("");
  });

  test("a field with no minimum width never warns", async () => {
    mountInField();
    await open({ items: [SECOND], next: null });
    cards()[0]?.click();

    expect(warning().hidden).toBe(true);
    expect(warning().textContent).toBe("");
  });

  // The stored upload's width comes down with the picker, so a field that
  // already holds a too-narrow image warns on load rather than waiting for the
  // editor to pick the same image again.
  test("warns about a stored narrow image before any interaction", () => {
    mountInField(1600, 800);

    const field = document.querySelector<HTMLElement>("[data-field]");
    expect(field?.dataset.imageWidth).toBe("800");
    expect(warning().hidden).toBe(false);
    expect(warning().textContent).toContain("800px");
  });

  test("leaves the warning hidden on load when the stored image is wide enough", () => {
    mountInField(1600, 1600);

    expect(warning().hidden).toBe(true);
    expect(warning().textContent).toBe("");
  });

  // A list row or block is cloned from a <template> after this module ran, so
  // its picker is not in the page at load. It must still work, and bind once.
  test("binds a picker inserted after the module ran, once", async () => {
    const row = document.createElement("div");
    row.innerHTML = `<div data-list-item><div data-field data-field-kind="image" data-field-name="item">${pickerField()}</div></div>`;
    document.body.append(row);
    await flush();

    const choose = row.querySelector<HTMLButtonElement>(
      "[data-image-picker-choose]",
    );
    if (!choose) throw new Error("no choose button in the row");
    pages = [{ items: [FIRST], next: null }];
    choose.click();
    await flush();

    // One request: a second binding would open the dialog (and load) twice.
    expect(requested).toEqual(["/cms/media/options?"]);
    expect(
      row.querySelector<HTMLElement>("[data-image-picker-modal]")?.hidden,
    ).toBe(false);

    row.querySelector<HTMLElement>("[data-image-picker-option]")?.click();
    expect(
      row.querySelector<HTMLInputElement>("[data-image-picker-value]")?.value,
    ).toBe(FIRST.id);
    expect(
      row.querySelector<HTMLElement>("[data-image-picker-alt]")?.textContent,
    ).toBe(FIRST.alt);

    // Remove works on the late picker too, and leaves only its row empty.
    row.querySelector<HTMLElement>("[data-image-picker-remove]")?.click();
    expect(
      row.querySelector<HTMLInputElement>("[data-image-picker-value]")?.value,
    ).toBe("");
    expect(el.value().value).toBe("");
  });
});
