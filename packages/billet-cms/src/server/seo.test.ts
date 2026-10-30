import { describe, expect, test } from "bun:test";
import type { MediaVariant } from "../contract";
import type { CmsMedia } from "./media";
import type { CmsPage } from "./pages";
import { pageSeo, renderSeoTags, renderSitemapEntries } from "./seo";

const page = (overrides: Partial<CmsPage> = {}): CmsPage => ({
  id: "page-1",
  url: "/about",
  title: "About us",
  seoDescription: "Who we are.",
  socialImageId: null,
  pageType: "landing",
  blocks: [],
  lastModified: new Date("2026-10-10T09:00:00.000Z"),
  ...overrides,
});

const SITE = "https://example.com";

const variant = (width: number): MediaVariant => ({
  width,
  height: Math.round(width * 0.625),
  webpKey: `${width}.webp`,
  webpUrl: `https://cdn.example.com/${width}.webp`,
  fallbackKey: `${width}.jpg`,
  fallbackUrl: `https://cdn.example.com/${width}.jpg`,
});

const media = (variants: MediaVariant[]): CmsMedia => ({
  id: "media-1",
  alt: "A photo",
  width: 2400,
  height: 1500,
  focalPoint: { x: 0.5, y: 0.5 },
  variants,
});

/**
 * The `getMedia`-only shape `pageSeo` needs, plus the ids it was asked for.
 *
 * `stored` is what the reader holds: a deleted upload is `null`, the same
 * answer the real reader gives for a missing row.
 */
const reader = (stored: CmsMedia | null) => {
  const asked: string[] = [];
  return {
    asked,
    getMedia: async (id: string) => {
      asked.push(id);
      return stored && stored.id === id ? stored : null;
    },
  };
};

describe("pageSeo", () => {
  test("uses the page's own title, description and path", async () => {
    expect(await pageSeo(page(), { siteUrl: SITE })).toEqual({
      title: "About us",
      description: "Who we are.",
      canonicalPath: "/about",
      socialImage: null,
    });
  });

  test("falls back to the site's description when the page has none", async () => {
    const seo = await pageSeo(page({ seoDescription: null }), {
      fallbackDescription: "The site default.",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("treats a whitespace-only description as unset", async () => {
    const seo = await pageSeo(page({ seoDescription: "   " }), {
      fallbackDescription: "The site default.",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("trims the fallback so a padded default is not the tag's value", async () => {
    const seo = await pageSeo(page({ seoDescription: null }), {
      fallbackDescription: "  The site default.  ",
    });
    expect(seo.description).toBe("The site default.");
  });

  test("reads the page's social image id and uses the smallest large rendition", async () => {
    const mediaReader = reader(
      media([variant(480), variant(960), variant(1600), variant(2400)]),
    );
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
      media: mediaReader,
    });

    expect(mediaReader.asked).toEqual(["media-1"]);
    expect(seo.socialImage).toBe("https://cdn.example.com/1600.jpg");
  });

  test("uses the largest rendition when every one is narrower than a large card", async () => {
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
      media: reader(media([variant(480), variant(960)])),
    });

    expect(seo.socialImage).toBe("https://cdn.example.com/960.jpg");
  });

  test("resolves a relative rendition URL against the canonical origin", async () => {
    const relative: CmsMedia = {
      ...media([variant(1600)]),
      variants: [{ ...variant(1600), fallbackUrl: "/media/1600.jpg" }],
    };
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
      media: reader(relative),
    });

    expect(seo.socialImage).toBe("https://example.com/media/1600.jpg");
  });

  test("emits no image for an unset id, without reading media", async () => {
    const mediaReader = reader(media([variant(1600)]));
    const seo = await pageSeo(page(), { siteUrl: SITE, media: mediaReader });

    expect(seo.socialImage).toBeNull();
    expect(mediaReader.asked).toEqual([]);
  });

  test("emits no image for a deleted upload", async () => {
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
      media: reader(null),
    });

    expect(seo.socialImage).toBeNull();
  });

  test("emits no image for an upload with no renditions", async () => {
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
      media: reader(media([])),
    });

    expect(seo.socialImage).toBeNull();
  });

  test("emits no image when the site passed no media reader", async () => {
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: SITE,
    });

    expect(seo.socialImage).toBeNull();
  });

  // The site can hand these helpers anything; a malformed origin must not
  // throw inside a render.
  test("does not throw when the canonical origin can't resolve the image", async () => {
    const seo = await pageSeo(page({ socialImageId: "media-1" }), {
      siteUrl: "http://[",
      media: reader(media([variant(1600)])),
    });

    expect(seo.socialImage).toBe("https://cdn.example.com/1600.jpg");
  });
});

describe("renderSeoTags", () => {
  test("renders the canonical link and the social tags from the page", async () => {
    const html = renderSeoTags(await pageSeo(page()), { siteUrl: SITE });

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

  test("renders the image tags when the page set one", async () => {
    const html = renderSeoTags(
      await pageSeo(page({ socialImageId: "media-1" }), {
        siteUrl: SITE,
        media: reader(media([variant(1600)])),
      }),
      { siteUrl: SITE },
    );

    expect(html).toContain(
      '<meta property="og:image" content="https://cdn.example.com/1600.jpg">',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://cdn.example.com/1600.jpg">',
    );
  });

  // A page title is editor input, and a title that ends the tag's attribute
  // would otherwise be markup.
  test("escapes a title that tries to close the attribute", async () => {
    const html = renderSeoTags(
      await pageSeo(page({ title: '"><script>alert(1)</script>' })),
      { siteUrl: SITE },
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  // A page that never set a description, on a site with no fallback, must not
  // render an empty tag: the runbook treats it as a per-page omission.
  test("leaves out both description tags when there is no description", async () => {
    const html = renderSeoTags(await pageSeo(page({ seoDescription: null })), {
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

  test("does not throw when the canonical origin can't resolve a path", async () => {
    const seo = await pageSeo(page());
    expect(() => renderSeoTags(seo, { siteUrl: "" })).not.toThrow();
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
