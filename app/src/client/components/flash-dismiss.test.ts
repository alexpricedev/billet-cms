import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { init } from "./flash-dismiss";

const markup = `
  <div class="flash" data-tone="success" role="status">
    <div class="flash-body"><p class="flash-title">Draft saved.</p></div>
    <button type="button" class="flash-dismiss" aria-label="Dismiss" data-flash-dismiss hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
    </button>
  </div>
  <div class="flash" data-tone="error" role="alert">
    <div class="flash-body"><p class="flash-title">Couldn't save draft.</p></div>
    <button type="button" class="flash-dismiss" aria-label="Dismiss" data-flash-dismiss hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
    </button>
  </div>
`;

const banners = () => document.querySelectorAll<HTMLElement>(".flash");
const dismissButtons = () =>
  document.querySelectorAll<HTMLButtonElement>("[data-flash-dismiss]");

describe("flash dismiss", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
    init();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("reveals the dismiss button on every banner", () => {
    expect(dismissButtons()).toHaveLength(2);
    for (const button of dismissButtons()) {
      // The button ships hidden so a page without this script has no × at all.
      expect(button.hidden).toBe(false);
    }
  });

  test("removes the banner the button belongs to", () => {
    dismissButtons()[0].click();

    expect(banners()).toHaveLength(1);
    expect(banners()[0].dataset.tone).toBe("error");
  });
});

describe("flash dismiss without a banner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("leaves markup that has no dismiss button alone", () => {
    document.body.innerHTML = "<main><p>no banner here</p></main>";

    expect(() => init()).not.toThrow();
    expect(document.querySelector("main")).not.toBeNull();
  });
});
