import { describe, expect, test } from "bun:test";
import { buildLlmsTxt } from "./llms-txt";
import { SITE_NAME, SITEMAP_PATHS, siteUrl } from "./seo";

describe("buildLlmsTxt", () => {
  test("opens with the H1 site name and a blockquote summary", () => {
    const body = buildLlmsTxt();

    expect(body).toStartWith(`# ${SITE_NAME}\n`);
    expect(body).toMatch(/^> .+/m);
  });

  test("groups links under a Resources heading", () => {
    const body = buildLlmsTxt();

    expect(body).toContain("## Resources");
  });

  test("lists every public sitemap path as an absolute markdown link", () => {
    const body = buildLlmsTxt();

    for (const path of SITEMAP_PATHS) {
      const href = new URL(path, siteUrl()).href;
      expect(body).toContain(`](${href}):`);
    }
  });

  test("omits a Pages section when the CMS has no public pages", () => {
    // The Forms demo was the only public page and has been removed (14 Oct).
    const body = buildLlmsTxt();

    expect(body).not.toContain("## Pages");
    expect(body).not.toContain("/forms");
    expect(body).toContain("## Resources");
  });

  test("points agents at the sitemap and security policy resources", () => {
    const body = buildLlmsTxt();

    expect(body).toContain(`${siteUrl()}/sitemap.xml`);
    expect(body).toContain(`${siteUrl()}/.well-known/security.txt`);
  });
});
