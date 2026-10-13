/**
 * Image fixtures for the media tests.
 *
 * Real encodes, not hand-written byte soups: the media pipeline runs Sharp, so
 * a fixture that Sharp can't decode would test the wrong thing. `withExif`
 * splices a minimal EXIF block (an orientation and a GPS pointer) into an
 * otherwise plain JPEG — the one way to test that rotation is applied and that
 * EXIF, GPS included, is stripped.
 */
import sharp from "sharp";

export const makeJpeg = async (
  width: number,
  height: number,
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#cc3333" },
    })
      .jpeg()
      .toBuffer(),
  );

export const makePng = async (
  width: number,
  height: number,
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  );

/** A PNG whose header only claims these dimensions — for the pixel-cap check. */
export const fakePngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

export const svgBytes = (): Uint8Array =>
  new TextEncoder().encode(
    "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10'/></svg>",
  );

export const gifBytes = (): Uint8Array => {
  const bytes = new Uint8Array(14);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, 8, true);
  view.setUint16(8, 8, true);
  return bytes;
};

/**
 * Splice an EXIF APP1 segment into a JPEG.
 *
 * The block carries IFD0 with Orientation = 6 (rotate 90° clockwise to display)
 * and a GPS IFD pointer, whose GPS IFD holds a latitude and longitude reference
 * — enough that "GPS was stripped" means something. Offsets are TIFF-relative,
 * little-endian.
 */
export const withExif = (jpeg: Uint8Array): Uint8Array => {
  const data = "N\u0000W\u0000";
  const tiff = new Uint8Array(72);
  const view = new DataView(tiff.buffer);
  const gpsOffset = 38;
  const stringOffset = 68;

  // TIFF header.
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  view.setUint16(2, 0x2a, true);
  view.setUint32(4, 8, true);

  const entry = (
    offset: number,
    tag: number,
    type: number,
    value: number,
  ): void => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, 1, true);
    view.setUint32(offset + 8, value, true);
  };

  // IFD0: Orientation (SHORT 3) and a GPS IFD pointer (LONG 4).
  view.setUint16(8, 2, true);
  entry(10, 0x0112, 3, 6);
  entry(22, 0x8825, 4, gpsOffset);
  view.setUint32(34, 0, true);

  // GPS IFD: a latitude reference and a longitude reference (ASCII 2).
  view.setUint16(gpsOffset, 2, true);
  view.setUint16(gpsOffset + 2, 0x0001, true);
  view.setUint16(gpsOffset + 4, 2, true);
  view.setUint32(gpsOffset + 6, 2, true);
  view.setUint32(gpsOffset + 10, stringOffset, true);
  view.setUint16(gpsOffset + 14, 0x0003, true);
  view.setUint16(gpsOffset + 16, 2, true);
  view.setUint32(gpsOffset + 18, 2, true);
  view.setUint32(gpsOffset + 22, stringOffset + 2, true);
  view.setUint32(gpsOffset + 26, 0, true);

  for (let index = 0; index < data.length; index += 1) {
    tiff[stringOffset + index] = data.charCodeAt(index);
  }

  const app1Length = 2 + 6 + tiff.length;
  const segment = new Uint8Array(2 + app1Length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, app1Length);
  segment.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  segment.set(tiff, 10);

  // SOI, then the EXIF segment, then the original JPEG payload.
  const out = new Uint8Array(2 + segment.length + (jpeg.length - 2));
  out.set([0xff, 0xd8], 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
};
