import { describe, expect, test } from "bun:test";
import type { MediaVariant } from "@alexpricedev/billet-cms/contract";
import type { MediaRecord } from "../../services/media";
import { variantForDisplay } from "./media";

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

  test("returns undefined for a row with no renditions", () => {
    expect(variantForDisplay(media([]), 192)).toBeUndefined();
  });
});
