import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  hasGpsCoordinates,
  makeJpeg,
  makePng,
  withExif,
  withFullMetadata,
} from "../../test-utils/images";
import { processImage, renditionWidths } from "./processor";

describe("renditionWidths", () => {
  test("covers the fixed ladder and the source's own width, ascending", () => {
    expect(renditionWidths(3000)).toEqual([480, 960, 1600, 2400, 3000]);
    expect(renditionWidths(2000)).toEqual([480, 960, 1600, 2000]);
    expect(renditionWidths(2400)).toEqual([480, 960, 1600, 2400]);
  });

  test("never invents a width wider than the source", () => {
    expect(renditionWidths(1000)).toEqual([480, 960, 1000]);
    expect(renditionWidths(300)).toEqual([300]);
  });
});

describe("processImage", () => {
  test("applies EXIF rotation, then strips EXIF and GPS", async () => {
    const tagged = withExif(await makeJpeg(40, 20));

    // The fixture really carries EXIF (orientation plus a GPS IFD) before it is
    // processed, or the assertions below would pass on a source with none.
    const before = await sharp(tagged).metadata();
    expect(before.orientation).toBe(6);
    expect((before.exif?.length ?? 0) > 0).toBe(true);

    const processed = await processImage(tagged, "jpeg");
    // Orientation 6 means "rotate 90° clockwise", so 40x20 displays as 20x40.
    expect(processed.width).toBe(20);
    expect(processed.height).toBe(40);

    const after = await sharp(processed.original.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
  });

  test("strips EXIF (GPS included), XMP and ICC from every rendition", async () => {
    const fixture = await withFullMetadata(await makeJpeg(1200, 800));

    // The fixture carries all three kinds before it is processed, so the
    // assertions below are not passing on a source that never had them.
    const before = await sharp(fixture).metadata();
    expect(before.exif).toBeDefined();
    expect(before.icc).toBeDefined();
    expect(before.xmp).toBeDefined();
    expect(hasGpsCoordinates(before.exif)).toBe(true);

    const processed = await processImage(fixture, "jpeg");
    const outputs = [
      processed.original.bytes,
      ...processed.renditions.flatMap((rendition) => [
        rendition.webp,
        rendition.fallback,
      ]),
    ];
    for (const bytes of outputs) {
      const meta = await sharp(bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
  });

  test("generates every width, each a decodable WebP and fallback", async () => {
    const processed = await processImage(await makeJpeg(3000, 1500), "jpeg");

    expect(processed.renditions.map((r) => r.width)).toEqual([
      480, 960, 1600, 2400, 3000,
    ]);
    for (const rendition of processed.renditions) {
      // The aspect ratio is preserved and the rendition's own size is honest.
      expect(rendition.height).toBe(rendition.width / 2);

      const webp = await sharp(rendition.webp).metadata();
      expect(webp.format).toBe("webp");
      expect(webp.width).toBe(rendition.width);

      const fallback = await sharp(rendition.fallback).metadata();
      expect(fallback.format).toBe("jpeg");
      expect(fallback.width).toBe(rendition.width);
    }
  });

  test("a source narrower than the smallest rung gets one rendition at its width", async () => {
    const processed = await processImage(await makeJpeg(320, 200), "jpeg");
    expect(processed.renditions.map((r) => r.width)).toEqual([320]);
  });

  test("a PNG keeps a PNG fallback, so transparency survives", async () => {
    const processed = await processImage(await makePng(800, 400), "png");
    expect(processed.original.extension).toBe("png");

    const rendition = processed.renditions[0];
    expect(Array.from(rendition.fallback.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    const webp = await sharp(rendition.webp).metadata();
    expect(webp.format).toBe("webp");
    expect(webp.hasAlpha).toBe(true);
  });
});
