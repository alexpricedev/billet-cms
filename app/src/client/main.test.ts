import { afterEach, describe, expect, test } from "bun:test";

describe("main page router", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.page;
  });

  test("boots without throwing", async () => {
    await import("./main");
    expect(true).toBe(true);
  });
});

describe("confirm dialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("a form with data-confirm is held for confirmation instead of posting", async () => {
    await import("./main");
    document.body.innerHTML = `<form method="POST" action="/x" data-confirm="Sure?" data-confirm-title="Publish 'A'?"><button type="submit">Go</button></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
