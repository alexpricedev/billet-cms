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

beforeEach(() => {
  document.body.innerHTML = MARKUP;
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
