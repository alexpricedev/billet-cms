import { describe, expect, test } from "bun:test";
import type { CmsPage } from "./pages";
import { pageSeo, renderSeoTags, renderSitemapEntries } from "./seo";

const page = (overrides: Partial<CmsPage> = {}): CmsPage => ({
  id: "page-1",
  url: "/about",
  title: "About us",
  seoDescription: "Who we are.",
  socialImage: null,
  pageType: "landing",
  blocks: [],
  lastModified: new Date("2026-10-10T09:00:00.000Z"),
  ...overrides,
});

const SITE = "https://example.com";

describe("pageSeo", () => {
  test("uses the page's own title, description and path", () => {
    expect(pageSeo(page(), { siteUrl: SITE })).toEqual({
      title: "About us",
      description: "Who we are.",
      canonicalPath: "/about",
      socialImage: null,
    });
  });

  test("falls back to the site's description when the page has none", () => {
    const seo = pageSeo(page({ seoDescription: null }), {
      fallbackDescription: "The site default.",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("treats a whitespace-only description as unset", () => {
    const seo = pageSeo(page({ seoDescription: "   " }), {
      fallbackDescription: "The site default.",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("trims the fallback so a padded default is not the tag's value", () => {
    const seo = pageSeo(page({ seoDescription: null }), {
      fallbackDescription: "  The site default.  ",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("resolves a relative social image against the canonical origin", () => {
    const seo = pageSeo(page({ socialImage: "/og/about.png" }), {
      siteUrl: SITE,
    });
    expect(seo.socialImage).toBe("https://example.com/og/about.png");
  });

  // A page's settings are validated on write, but the site can hand these
  // helpers anything; a malformed value must not throw inside a render.
  test("leaves an unparseable social image as it is, without throwing", () => {
    const seo = pageSeo(page({ socialImage: "http://[" }), { siteUrl: SITE });
    expect(seo.socialImage).toBe("http://[");
    expect(() =>
      pageSeo(page({ socialImage: "/og.png" }), { siteUrl: "" }),
    ).not.toThrow();
  });
});

describe("renderSeoTags", () => {
  test("renders the canonical link and the social tags from the page", () => {
    const html = renderSeoTags(pageSeo(page()), { siteUrl: SITE });

    expect(html).toContain(
      '<link rel="canonical" href="https://example.com/about">',
    );
    expect(html).toContain('<meta property="og:title" content="About us">');
    expect(html).toContain(
      '<meta property="og:url" content="https://example.com/about">',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    // No social image set: neither og:image nor twitter:image is rendered.
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
  });

  test("renders the image tags when the page set one", () => {
    const html = renderSeoTags(
      pageSeo(page({ socialImage: "/og.png" }), { siteUrl: SITE }),
      { siteUrl: SITE },
    );

    expect(html).toContain(
      '<meta property="og:image" content="https://example.com/og.png">',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://example.com/og.png">',
    );
  });

  // A page title is editor input, and a title that ends the tag's attribute
  // would otherwise be markup.
  test("escapes a title that tries to close the attribute", () => {
    const html = renderSeoTags(
      pageSeo(page({ title: '"><script>alert(1)</script>' })),
      { siteUrl: SITE },
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  // A page that never set a description, on a site with no fallback, must not
  // render an empty tag: the runbook treats it as a per-page omission.
  test("leaves out both description tags when there is no description", () => {
    const html = renderSeoTags(pageSeo(page({ seoDescription: null })), {
      siteUrl: SITE,
    });

    expect(html).not.toContain("og:description");
    expect(html).not.toContain("twitter:description");
    // The rest of the tags are unaffected.
    expect(html).toContain('<meta property="og:title" content="About us">');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
  });

  // `pageSeo` trims, but a `PageSeo` built by hand can carry whitespace; the
  // tag check is on the trimmed value so a blank description is still omitted.
  test("leaves out both description tags for a whitespace-only description", () => {
    const html = renderSeoTags(
      {
        title: "About us",
        description: "   ",
        canonicalPath: "/about",
        socialImage: null,
      },
      { siteUrl: SITE },
    );

    expect(html).not.toContain("og:description");
    expect(html).not.toContain("twitter:description");
  });

  test("does not throw when the canonical origin can't resolve a path", () => {
    expect(() => renderSeoTags(pageSeo(page()), { siteUrl: "" })).not.toThrow();
  });
});

describe("renderSitemapEntries", () => {
  test("renders absolute <loc> and an ISO <lastmod> for each page", () => {
    const xml = renderSitemapEntries(
      [
        {
          url: "/about",
          lastModified: new Date("2026-10-10T09:00:00.000Z"),
        },
      ],
      { siteUrl: SITE },
    );

    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("<lastmod>2026-10-10T09:00:00.000Z</lastmod>");
  });

  test("renders nothing for no pages", () => {
    expect(renderSitemapEntries([], { siteUrl: SITE })).toBe("");
  });

  test("does not throw on a URL it can't resolve", () => {
    expect(() =>
      renderSitemapEntries([{ url: "::", lastModified: new Date(0) }], {
        siteUrl: "",
      }),
    ).not.toThrow();
  });
});
