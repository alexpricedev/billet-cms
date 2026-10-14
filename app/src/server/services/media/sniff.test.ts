import { describe, expect, test } from "bun:test";
import { animatedWebpBytes, apngBytes } from "../../test-utils/images";
import {
  contentTypeFor,
  extensionFor,
  isAnimatedImage,
  readImageSize,
  sniffImageFormat,
} from "./sniff";

/** A PNG header with the given IHDR dimensions. */
const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

/** A JPEG whose only segment is an SOF0 carrying the dimensions. */
const jpegHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(12);
  bytes.set([0xff, 0xd8, 0xff, 0xc0], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 17); // segment length
  bytes[6] = 8; // precision
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
};

/** A lossy WebP header (VP8) with the given dimensions. */
const webpHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  bytes.set([0x9d, 0x01, 0x2a], 23);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
};

/** A GIF header with the given logical screen dimensions. */
const gifHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
};

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("sniffImageFormat", () => {
  test("recognises the accepted formats from their magic bytes", () => {
    expect(sniffImageFormat(pngHeader(10, 10))).toBe("png");
    expect(sniffImageFormat(jpegHeader(10, 10))).toBe("jpeg");
    expect(sniffImageFormat(webpHeader(10, 10))).toBe("webp");
  });

  test("reads an animated WebP or APNG as its still format", () => {
    // The magic bytes can't tell them apart from a still image; the animation
    // check below is what refuses them.
    expect(sniffImageFormat(animatedWebpBytes())).toBe("webp");
    expect(sniffImageFormat(apngBytes())).toBe("png");
  });

  test("recognises GIF and SVG so they can be refused by name", () => {
    expect(sniffImageFormat(gifHeader(10, 10))).toBe("gif");
    expect(
      sniffImageFormat(text("<svg xmlns='http://www.w3.org/2000/svg'>")),
    ).toBe("svg");
    expect(sniffImageFormat(text("  <?xml version='1.0'?><svg>"))).toBe("svg");
  });

  test("returns null for anything else", () => {
    expect(sniffImageFormat(text("hello"))).toBeNull();
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
  });

  test("does not mistake a RIFF container that isn't WebP for one", () => {
    const wav = new Uint8Array(16);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(sniffImageFormat(wav)).toBeNull();
  });
});

describe("readImageSize", () => {
  test("reads PNG dimensions from IHDR", () => {
    expect(readImageSize(pngHeader(1920, 1080), "png")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test("reads JPEG dimensions from SOF0", () => {
    expect(readImageSize(jpegHeader(4000, 3000), "jpeg")).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  test("reads WebP dimensions", () => {
    expect(readImageSize(webpHeader(1600, 900), "webp")).toEqual({
      width: 1600,
      height: 900,
    });
  });

  test("reads GIF dimensions", () => {
    expect(readImageSize(gifHeader(64, 48), "gif")).toEqual({
      width: 64,
      height: 48,
    });
  });

  test("returns null for a truncated or malformed header", () => {
    expect(readImageSize(pngHeader(10, 10).slice(0, 12), "png")).toBeNull();
    expect(
      readImageSize(new Uint8Array([0xff, 0xd8, 0xff]), "jpeg"),
    ).toBeNull();
    expect(readImageSize(text("<svg/>"), "svg")).toBeNull();
  });
});

describe("isAnimatedImage", () => {
  test("flags an animated WebP from its VP8X animation flag", () => {
    expect(isAnimatedImage(animatedWebpBytes(), "webp")).toBe(true);
    expect(isAnimatedImage(webpHeader(10, 10), "webp")).toBe(false);
  });

  test("flags an APNG from its acTL chunk", () => {
    expect(isAnimatedImage(apngBytes(), "png")).toBe(true);
    expect(isAnimatedImage(pngHeader(10, 10), "png")).toBe(false);
  });

  test("does not flag a JPEG or a GIF", () => {
    expect(isAnimatedImage(jpegHeader(10, 10), "jpeg")).toBe(false);
    expect(isAnimatedImage(gifHeader(10, 10), "gif")).toBe(false);
  });
});

describe("format helpers", () => {
  test("map an accepted format to its type and extension", () => {
    expect(contentTypeFor("jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("png")).toBe("image/png");
    expect(contentTypeFor("webp")).toBe("image/webp");
    expect(extensionFor("jpeg")).toBe("jpg");
    expect(extensionFor("png")).toBe("png");
    expect(extensionFor("webp")).toBe("webp");
  });
});
