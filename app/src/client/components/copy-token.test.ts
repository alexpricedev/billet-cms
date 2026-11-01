import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { init } from "./copy-token";

const TOKEN = "cms_export_3f9a1c7e5b2d8f4061a9c4e7b0d2f6a8c1e5b9d3";

// The create response's banner: the raw token in a <code> with Copy beside it.
// Copy ships hidden, as the server renders it, and the script reveals it.
const markup = `
  <div class="flash" data-tone="warning" role="status">
    <div class="flash-body">
      <p class="flash-title">Copy this token now.</p>
      <p class="cms-token-row" data-token-row>
        <code data-export-token>${TOKEN}</code>
        <button type="button" class="btn btn-ghost btn-sm" data-copy-token hidden>Copy</button>
      </p>
    </div>
  </div>
`;

const button = () =>
  document.querySelector<HTMLButtonElement>(
    "[data-copy-token]",
  ) as HTMLButtonElement | null;

// The click handler settles a promise chain; a couple of ticks is enough for
// both the write and the fallback that follows a refusal.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let written: string[] = [];
let teardown = () => {};

const setClipboard = (write: ((text: string) => Promise<void>) | null) => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: write ? { writeText: write } : undefined,
  });
};

const start = (
  write: (text: string) => Promise<void> = async (text) => {
    written.push(text);
  },
) => {
  teardown();
  document.body.innerHTML = markup;
  written = [];
  setClipboard(write);
  teardown = init();
};

beforeEach(() => {
  jest.useFakeTimers();
  start();
});

afterEach(() => {
  teardown();
  teardown = () => {};
  jest.useRealTimers();
  document.body.innerHTML = "";
  // The clipboard is happy-dom's, not this file's; put the prototype's back.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("copy token", () => {
  test("reveals the button and copies the token it sits beside", async () => {
    // Hidden until the script runs: with JavaScript off the token is still
    // there to select, but a Copy button would be a control that does nothing.
    expect(button()?.hidden).toBe(false);

    button()?.click();
    await flush();

    expect(written).toEqual([TOKEN]);
  });

  test("says Copied, then goes back to Copy", async () => {
    button()?.click();
    await flush();

    expect(button()?.textContent).toBe("Copied");

    jest.advanceTimersByTime(2000);

    expect(button()?.textContent).toBe("Copy");
  });

  // A refused write (permission denied, or a page that is not a secure
  // context) must still leave the editor able to copy: select the token so
  // their own Copy shortcut or long press finishes the job.
  test("selects the token text when the clipboard is refused", async () => {
    start(() => Promise.reject(new Error("clipboard denied")));

    button()?.click();
    await flush();

    expect(window.getSelection()?.toString()).toBe(TOKEN);
    // It was not copied, so it must not claim to have been.
    expect(button()?.textContent).toBe("Copy");
  });

  test("selects the token text when the browser has no clipboard", () => {
    teardown();
    document.body.innerHTML = markup;
    setClipboard(null);
    teardown = init();

    button()?.click();

    expect(window.getSelection()?.toString()).toBe(TOKEN);
    expect(button()?.textContent).toBe("Copy");
  });

  test("stops listening once the page is torn down", () => {
    teardown();
    teardown = () => {};

    button()?.click();

    expect(written).toEqual([]);
  });

  test("does nothing on a page with no token row", () => {
    document.body.innerHTML = "<p>no token here</p>";

    expect(() => init()()).not.toThrow();
  });
});
