import { describe, expect, test } from "bun:test";
import { sitemap } from "./sitemap";

describe("Sitemap Controller", () => {
  test("serves valid XML with the correct content type", async () => {
    const response = sitemap.index();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/xml; charset=utf-8",
    );
    expect(body).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
  });

  test("lists no public paths — the CMS serves no public pages", async () => {
    const body = await sitemap.index().text();

    expect(body).not.toContain("<loc>");
    expect(body).not.toContain("</loc>");
  });

  test("omits private and non-indexable routes", async () => {
    const body = await sitemap.index().text();

    expect(body).not.toContain("/admin");
    expect(body).not.toContain("/login");
    expect(body).not.toContain("/sign-in");
    expect(body).not.toContain("/api/");
    // The /forms demo was removed; a stale loc would send crawlers to a 404.
    expect(body).not.toContain("/forms");
  });
});
