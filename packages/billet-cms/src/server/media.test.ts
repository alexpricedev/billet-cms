import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { MediaVariant } from "../contract";
import { createCmsMedia, getMedia, renderCmsImage } from "./media";

const variants: MediaVariant[] = [
  {
    width: 480,
    height: 270,
    webpKey: "media/1/480.webp",
    webpUrl: "https://media.test/media/1/480.webp",
    fallbackKey: "media/1/480.jpg",
    fallbackUrl: "https://media.test/media/1/480.jpg",
  },
  {
    width: 960,
    height: 540,
    webpKey: "media/1/960.webp",
    webpUrl: "https://media.test/media/1/960.webp",
    fallbackKey: "media/1/960.jpg",
    fallbackUrl: "https://media.test/media/1/960.jpg",
  },
];

const media = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  alt: "A fox",
  width: 960,
  height: 540,
  focalPoint: { x: 0.25, y: 0.75 },
  variants,
};

describe("renderCmsImage", () => {
  const html = renderCmsImage(media);

  test("renders a picture with a WebP source and the fallback as the image", () => {
    expect(html).toContain("<picture>");
    expect(html).toContain('<source type="image/webp"');
    expect(html).toContain(
      'srcset="https://media.test/media/1/480.webp 480w, https://media.test/media/1/960.webp 960w"',
    );
    // The <img> falls back to the largest original-format rendition.
    expect(html).toContain('src="https://media.test/media/1/960.jpg"');
    expect(html).toContain(
      'srcset="https://media.test/media/1/480.jpg 480w, https://media.test/media/1/960.jpg 960w"',
    );
  });

  test("carries width, height and the focal point's object-position", () => {
    expect(html).toContain('width="960"');
    expect(html).toContain('height="540"');
    expect(html).toContain("object-fit:cover");
    expect(html).toContain("object-position:25% 75%");
  });

  test("uses the media's alt, and a use can override it", () => {
    expect(html).toContain('alt="A fox"');
    const overridden = renderCmsImage(media, { alt: "A red fox" });
    expect(overridden).toContain('alt="A red fox"');
  });

  test("escapes the alt text", () => {
    const escaped = renderCmsImage({ ...media, alt: '" onerror="alert(1)' });
    expect(escaped).not.toContain('onerror="alert(1)"');
    expect(escaped).toContain("&quot;");
  });

  test("respects a sizes override", () => {
    const withSizes = renderCmsImage(media, {
      sizes: "(min-width: 40em) 50vw, 100vw",
    });
    expect(withSizes).toContain('sizes="(min-width: 40em) 50vw, 100vw"');
  });

  test("renders nothing when the row has no renditions", () => {
    expect(renderCmsImage({ ...media, variants: [] })).toBe("");
  });
});

const mediaRow = {
  id: media.id,
  alt: "A fox",
  width: 960,
  height: 540,
  focal_x: 0.25,
  focal_y: 0.75,
  variants: [...variants].reverse(),
};

const fakeSql = (options: { versionFails?: boolean } = {}) => {
  const state = { versionReads: 0 };
  const sql = {
    unsafe: (query: string) => {
      if (query.includes("cms_meta")) {
        state.versionReads += 1;
        if (options.versionFails) {
          throw new Error('relation "cms_meta" does not exist');
        }
        return Promise.resolve([{ content_version: 1 }]);
      }
      if (query.includes("cms_media")) {
        return Promise.resolve([mediaRow]);
      }
      return Promise.resolve([]);
    },
  } as unknown as SQL;
  return { state, sql };
};

describe("createCmsMedia", () => {
  test("reads a row, sorting its variants ascending", async () => {
    const { sql } = fakeSql();
    const reader = createCmsMedia({ sql });

    const found = await reader.getMedia(media.id);
    expect(found).not.toBeNull();
    expect(found?.alt).toBe("A fox");
    expect(found?.focalPoint).toEqual({ x: 0.25, y: 0.75 });
    expect(found?.variants.map((variant) => variant.width)).toEqual([480, 960]);
  });

  test("returns null and reports when the CMS isn't readable", async () => {
    const skipped: string[] = [];
    const throwing = {
      unsafe: () => {
        throw new Error('relation "cms_meta" does not exist');
      },
    } as unknown as SQL;

    const reader = createCmsMedia({
      sql: throwing,
      onSkip: (m) => skipped.push(m),
    });
    expect(await reader.getMedia(media.id)).toBeNull();
    expect(skipped[0]).toContain("could not read media");
  });

  test("caches a read and revalidates on the content version", async () => {
    const { state, sql } = fakeSql();
    const reader = createCmsMedia({ sql, now: () => 0 });

    expect(await reader.getMedia(media.id)).not.toBeNull();
    expect(await reader.getMedia(media.id)).not.toBeNull();
    // One version check serves both reads inside the poll interval.
    expect(state.versionReads).toBe(1);
  });

  test("getMedia is a convenience over a per-pool reader", async () => {
    const { sql } = fakeSql();
    expect(await getMedia(sql, media.id)).not.toBeNull();
  });
});
