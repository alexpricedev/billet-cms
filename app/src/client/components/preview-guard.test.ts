import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** What the dialog was asked, and what it will answer. */
let asked: unknown = null;
let answer = true;

mock.module("@alexpricedev/billet-dialog", () => ({
  Dialog: {
    confirm: async (opts: unknown) => {
      asked = opts;
      return answer;
    },
  },
}));

const { init } = await import("./preview-guard");

const MARKUP = `
  <form method="POST" action="/cms/slots/s1" data-cms-form>
    <input type="text" data-text-input value="">
    <input type="hidden" name="after" value="" data-save-after>
  </form>
  <form method="POST" action="/cms/slots/s1/preview" target="_blank">
    <button type="submit" data-preview-submit>Preview draft</button>
  </form>
`;

// The server's no-draft state: Preview is disabled and the reason line says
// why. The guard may only open it once the editor has typed something.
const NO_DRAFT_MARKUP = `
  <form method="POST" action="/cms/slots/s1" data-cms-form>
    <input type="text" data-text-input value="">
    <input type="hidden" name="after" value="" data-save-after>
  </form>
  <form method="POST" action="/cms/slots/s1/preview" target="_blank">
    <button type="submit" data-preview-submit disabled aria-describedby="preview-reason">Preview draft</button>
  </form>
  <p class="cms-action-reason">
    <span id="publish-reason">Nothing to publish: no draft saved yet.</span>
    <span id="preview-reason" data-preview-reason>No draft to preview.</span>
  </p>
`;

const form = () => document.querySelector("[data-cms-form]") as HTMLFormElement;
const preview = () =>
  document.querySelector("[data-preview-submit]") as HTMLButtonElement;
const afterField = () =>
  document.querySelector("[data-save-after]") as HTMLInputElement;

const type = (value: string) => {
  const input = form().querySelector("[data-text-input]") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const clickPreview = () =>
  preview().dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );

let submitted = 0;
let teardown = () => {};

const start = (markup: string) => {
  teardown();
  document.body.innerHTML = markup;
  asked = null;
  answer = true;
  submitted = 0;
  // happy-dom has no form submission; count the request instead.
  form().requestSubmit = () => {
    submitted += 1;
  };
  // A click the guard lets through really does submit the preview form, which
  // happy-dom has no navigation for. Hold it here so the test can assert that
  // it was *not* cancelled without the environment trying to follow it.
  (preview().closest("form") as HTMLFormElement).addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
    },
  );
  teardown = init();
};

beforeEach(() => {
  start(MARKUP);
});

afterEach(() => {
  teardown();
  document.body.innerHTML = "";
});

describe("preview guard", () => {
  // The whole point: Preview posts the last saved revision, so pressing it
  // with unsaved edits on screen opens a tab showing older words.
  test("asks before previewing a form with unsaved edits", () => {
    type("changed");

    const notCancelled = clickPreview();

    expect(notCancelled).toBe(false);
    expect(asked).toMatchObject({ confirmLabel: "Save and preview" });
  });

  test("saves, carrying the intent, when the editor confirms", async () => {
    type("changed");
    clickPreview();
    await Promise.resolve();

    expect(afterField().value).toBe("preview");
    expect(submitted).toBe(1);
  });

  test("leaves the draft alone when the editor keeps editing", async () => {
    answer = false;
    type("changed");
    clickPreview();
    await Promise.resolve();

    expect(afterField().value).toBe("");
    expect(submitted).toBe(0);
  });

  // An untouched form is already what the preview would show, so the dialog
  // would be a question with one answer.
  test("does not interrupt a preview of an unedited form", () => {
    const notCancelled = clickPreview();

    expect(notCancelled).toBe(true);
    expect(asked).toBeNull();
  });

  test("asks again after a save that was re-rendered", () => {
    type("changed");
    form().dispatchEvent(new Event("submit", { bubbles: true }));

    expect(clickPreview()).toBe(true);

    type("changed again");

    expect(clickPreview()).toBe(false);
  });

  test("does nothing on a page without the two forms", () => {
    document.body.innerHTML = "<p>no form here</p>";

    expect(() => init()()).not.toThrow();
  });
});

// With no draft (or a draft already live) the server renders Preview disabled:
// from a clean page there is nothing unpublished to show. Unsaved edits are
// something to preview, so the guard opens the button and drops the reason
// until a submit makes the form clean again.
describe("preview guard on a form with nothing to preview", () => {
  const reason = () =>
    document.querySelector<HTMLElement>("[data-preview-reason]");

  test("leaves the server's disabled Preview alone until the form is edited", () => {
    start(NO_DRAFT_MARKUP);

    expect(preview().disabled).toBe(true);
    expect(preview().getAttribute("aria-describedby")).toBe("preview-reason");
    expect(reason()?.textContent).toBe("No draft to preview.");
  });

  test("opens Preview and drops the reason on the first edit", () => {
    start(NO_DRAFT_MARKUP);

    type("changed");

    expect(preview().disabled).toBe(false);
    expect(preview().hasAttribute("aria-describedby")).toBe(false);
    expect(reason()?.textContent).toBe("");
  });

  test("a click after editing asks to save first", () => {
    start(NO_DRAFT_MARKUP);
    type("changed");

    expect(clickPreview()).toBe(false);
    expect(asked).toMatchObject({ confirmLabel: "Save and preview" });
  });

  test("saves a first draft and carries the preview intent", async () => {
    start(NO_DRAFT_MARKUP);
    type("first words");

    clickPreview();
    await Promise.resolve();

    expect(afterField().value).toBe("preview");
    expect(submitted).toBe(1);
  });

  test("puts the disabled state and reason back when a submit makes it clean", () => {
    start(NO_DRAFT_MARKUP);
    type("changed");

    form().dispatchEvent(new Event("submit", { bubbles: true }));

    expect(preview().disabled).toBe(true);
    expect(preview().getAttribute("aria-describedby")).toBe("preview-reason");
    expect(reason()?.textContent).toBe("No draft to preview.");
  });
});
