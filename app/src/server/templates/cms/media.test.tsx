import { describe, expect, test } from "bun:test";
import type { MediaVariant } from "@alexpricedev/billet-cms/contract";
import { renderToString } from "preact-render-to-string";
import { MAX_ALT_LENGTH, type MediaRecord } from "../../services/media";
import { MediaDetail, MediaList, variantForDisplay } from "./media";

// The grid, picker and previews are all a fraction of the full-size original,
// so handing them the largest rendition wasted bandwidth on every card (review
// r1-13). The helper picks the smallest rendition at least twice the display
// width, which keeps it sharp on a 2x screen.
const variant = (width: number): MediaVariant => ({
  width,
  height: Math.round(width / 2),
  webpKey: `media/${width}.webp`,
  webpUrl: `https://media.test/media/${width}.webp`,
  fallbackKey: `media/${width}.jpg`,
  fallbackUrl: `https://media.test/media/${width}.jpg`,
});

const media = (widths: number[]): MediaRecord => ({
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  objectKey: "media/original.jpg",
  contentType: "image/jpeg",
  byteSize: 1,
  width: widths.at(-1) ?? 1,
  height: 1,
  alt: "A field",
  focalX: 0.5,
  focalY: 0.5,
  variants: widths.map(variant),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("variantForDisplay", () => {
  test("picks the smallest rendition at least twice the display width", () => {
    const record = media([480, 960, 1600, 2400, 3000]);
    expect(variantForDisplay(record, 160)?.width).toBe(480);
    expect(variantForDisplay(record, 192)?.width).toBe(480);
    // A 512px picker wants 1024px, so it skips to 1600.
    expect(variantForDisplay(record, 512)?.width).toBe(1600);
  });

  test("falls back to the largest rendition when none is big enough", () => {
    expect(variantForDisplay(media([200, 300]), 192)?.width).toBe(300);
  });

  test("caps the chosen rendition when a surface asks for it", () => {
    const record = media([480, 960, 1600, 2400, 3000]);

    // The focal picker caps at 960, so it skips the 1600 the 2x rule would pick.
    expect(variantForDisplay(record, 512, 960)?.width).toBe(960);
    // No rendition at or below the cap: the smallest it has is still used.
    expect(variantForDisplay(media([1200, 2400]), 512, 960)?.width).toBe(1200);
  });

  test("returns undefined for a row with no renditions", () => {
    expect(variantForDisplay(media([]), 192)).toBeUndefined();
  });
});

const ALT_HELP = `Up to ${MAX_ALT_LENGTH} characters.`;

const listHtml = (items: MediaRecord[] = []): string =>
  renderToString(
    <MediaList
      user={{ id: "u1", email: "editor@example.com", role: "editor" }}
      csrfToken="upload-token"
      items={items}
    />,
  );

/** Parsed rather than assigned to `document.body`, so layout scripts never load. */
const listDocument = (items: MediaRecord[] = []): Document =>
  new DOMParser().parseFromString(listHtml(items), "text/html");

// The page's one-file form is gone: the picker's drop zone stages several files
// and `media-upload.ts` asks for alt text per tile before anything is sent.
describe("MediaList uploader", () => {
  test("renders the picker's drop zone instead of an upload form", () => {
    const doc = listDocument();
    expect(doc.querySelector("form.cms-media-upload")).toBeNull();

    const drop = doc.querySelector("[data-media-upload] [data-media-drop]");
    expect(drop?.classList.contains("cms-picker-drop")).toBe(true);
    expect(drop?.textContent).toContain("Drop images here");
    expect(drop?.textContent).toContain("Choose file");
    expect(drop?.textContent).toContain("JPEG, PNG or WebP up to 20 MB");
    // The page cannot upload without its script and says so.
    expect(drop?.textContent).toContain("Uploading needs JavaScript");
  });

  test("takes several files at once and carries the upload token", () => {
    const doc = listDocument();
    const uploader = doc.querySelector("[data-media-upload]");
    expect(uploader?.getAttribute("data-media-upload-csrf")).toBe(
      "upload-token",
    );

    const file = doc.querySelector<HTMLInputElement>("[data-media-file]");
    expect(file?.multiple).toBe(true);
    expect(file?.getAttribute("accept")).toBe(
      "image/jpeg,image/png,image/webp",
    );
    expect(file?.closest("label")?.textContent).toContain("Choose file");
  });

  test("keeps Upload all hidden until the client stages several files", () => {
    const doc = listDocument();
    const uploadAll = doc.querySelector("[data-media-upload-all]");
    expect(uploadAll).not.toBeNull();
    expect(uploadAll?.hasAttribute("hidden")).toBe(true);
    // The client adds one tile per file here.
    expect(doc.querySelector("[data-media-staged]")).not.toBeNull();
  });

  test("loads the staged upload client", () => {
    expect(listHtml()).toContain('src="/assets/media-upload.js"');
  });
});

describe("MediaList grid", () => {
  test("renders the grid and the empty state when there are no images", () => {
    const doc = listDocument([]);
    const grid = doc.querySelector("[data-media-grid]");
    expect(grid).not.toBeNull();
    expect(grid?.children).toHaveLength(0);

    const empty = doc.querySelector("[data-media-empty]");
    expect(empty).not.toBeNull();
    expect(empty?.hasAttribute("hidden")).toBe(false);
    expect(empty?.textContent).toContain("No images yet");
  });

  test("hides the empty state once there is a card", () => {
    const doc = listDocument([media([480, 960])]);
    expect(
      doc.querySelector("[data-media-empty]")?.hasAttribute("hidden"),
    ).toBe(true);
  });

  // The picker's card shape: thumbnail, alt and W×H only, with the whole card
  // linked to the detail.
  test("shows a card with a thumbnail, alt text and dimensions", () => {
    const doc = listDocument([media([480, 960])]);
    const card = doc.querySelector(".cms-media-card");
    expect(card).not.toBeNull();

    const href = `/cms/media/${media([480, 960]).id}`;
    expect(card?.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(card?.querySelector(".cms-media-alt")?.getAttribute("href")).toBe(
      href,
    );
    expect(card?.querySelector(".cms-media-alt")?.textContent).toBe("A field");

    // variantForDisplay(192) picks the 480px rendition.
    const img = card?.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://media.test/media/480.jpg");
    expect(img?.getAttribute("alt")).toBe("A field");
    expect(img?.getAttribute("loading")).toBe("lazy");

    expect(card?.querySelector(".cms-media-meta")?.textContent).toBe("960×1");
    // No file size or type line on the picker-shaped card.
    expect(card?.textContent).not.toContain("JPEG");
    expect(card?.textContent).not.toContain("1 B");
  });

  test("uses the picker's placeholder when there is no thumbnail", () => {
    const doc = listDocument([media([])]);
    const card = doc.querySelector(".cms-media-card");
    expect(card?.querySelector("img")).toBeNull();
    expect(card?.querySelector(".cms-media-placeholder")?.textContent).toBe(
      "A field",
    );
  });
});

// r1-22: the detail's alt input carries `maxlength`, but the reason it stops at
// 1000 is only in the rendered help; the input points at it for a screen
// reader. (The upload's alt box is built by the client, whose own test pins
// the same help text.)
const altInput = (html: string): string =>
  /<input[^>]*id="cms-media-alt"[^>]*>/.exec(html)?.[0] ?? "";

describe("MediaDetail alt help", () => {
  const html = renderToString(
    <MediaDetail
      user={{ id: "u1", email: "editor@example.com", role: "editor" }}
      csrfToken="csrf-token"
      media={{ ...media([480, 960]), alt: "A field" }}
      usage={[]}
    />,
  );

  test("describes the detail's alt input with its length limit", () => {
    expect(altInput(html)).toContain('aria-describedby="cms-media-alt-help"');
    expect(html).toContain('id="cms-media-alt-help"');
    expect(html).toContain(ALT_HELP);
  });
});
