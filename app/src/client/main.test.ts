import { afterEach, describe, expect, test } from "bun:test";

describe("main page router", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.page;
  });

  test("boots without throwing for a registered page", async () => {
    document.body.dataset.page = "forms";
    await import("./main");
    expect(true).toBe(true);
  });
});
