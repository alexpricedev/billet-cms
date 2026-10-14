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
 * and a GPS IFD pointer, whose GPS IFD holds real latitude/longitude — a
 * reference string and three rational values for each — so "GPS was stripped"
 * means coordinates, not just an empty IFD. Offsets are TIFF-relative,
 * little-endian.
 */
export const withExif = (jpeg: Uint8Array): Uint8Array => {
  const tiff = new Uint8Array(144);
  const view = new DataView(tiff.buffer);
  const gpsOffset = 38;
  const stringOffset = 92; // "N\0W\0"
  const latitudeOffset = 96; // three rationals
  const longitudeOffset = 120; // three rationals

  // TIFF header.
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  view.setUint16(2, 0x2a, true);
  view.setUint32(4, 8, true);

  const entry = (
    offset: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ): void => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
  };

  const rational = (
    offset: number,
    numerator: number,
    denominator: number,
  ): void => {
    view.setUint32(offset, numerator, true);
    view.setUint32(offset + 4, denominator, true);
  };

  // IFD0: Orientation (SHORT 3) and a GPS IFD pointer (LONG 4).
  view.setUint16(8, 2, true);
  entry(10, 0x0112, 3, 1, 6);
  entry(22, 0x8825, 4, 1, gpsOffset);
  view.setUint32(34, 0, true);

  // GPS IFD: latitude and longitude references (ASCII) with the coordinate
  // rationals they describe. 51°30'0"N, 0°7'0"W.
  view.setUint16(gpsOffset, 4, true);
  entry(gpsOffset + 2, 0x0001, 2, 2, stringOffset);
  entry(gpsOffset + 14, 0x0002, 5, 3, latitudeOffset);
  entry(gpsOffset + 26, 0x0003, 2, 2, stringOffset + 2);
  entry(gpsOffset + 38, 0x0004, 5, 3, longitudeOffset);
  view.setUint32(gpsOffset + 50, 0, true);

  const data = "N\u0000W\u0000";
  for (let index = 0; index < data.length; index += 1) {
    tiff[stringOffset + index] = data.charCodeAt(index);
  }
  rational(latitudeOffset, 51, 1);
  rational(latitudeOffset + 8, 30, 1);
  rational(latitudeOffset + 16, 0, 1);
  rational(longitudeOffset, 0, 1);
  rational(longitudeOffset + 8, 7, 1);
  rational(longitudeOffset + 16, 0, 1);

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

const XMP_PACKET =
  "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF></x:xmpmeta>";

/**
 * A JPEG carrying every metadata category the pipeline must strip: EXIF (with
 * GPS coordinates), XMP and an ICC profile.
 *
 * XMP and ICC come from Sharp's own writers rather than being hand-spliced,
 * since both are large structured blobs; the EXIF with GPS is then spliced on
 * top. The result is a fixture that genuinely has each before processing, so
 * asserting their absence afterwards means something.
 */
export const withFullMetadata = async (
  jpeg: Uint8Array,
): Promise<Uint8Array> => {
  const tagged = await sharp(jpeg)
    .withXmp(XMP_PACKET)
    .withIccProfile("p3")
    .jpeg()
    .toBuffer();
  return withExif(new Uint8Array(tagged));
};

/** True when a raw EXIF buffer carries the GPS IFD pointer tag (0x8825). */
export const hasGpsCoordinates = (exif: Uint8Array | undefined): boolean => {
  if (!exif) return false;
  for (let index = 0; index < exif.length - 1; index += 1) {
    if (exif[index] === 0x25 && exif[index + 1] === 0x88) return true;
  }
  return false;
};

/**
 * An animated WebP header: a VP8X chunk with the animation flag (0x02) set.
 *
 * Only the header matters — the media service refuses it before decoding.
 */
export const animatedWebpBytes = (width = 8, height = 8): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes[20] = 0x02; // the ANIMATION flag
  bytes[24] = (width - 1) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  return bytes;
};

/**
 * An APNG header: a PNG signature and IHDR followed by an `acTL` chunk, which
 * is what marks a PNG as animated.
 */
export const apngBytes = (width = 8, height = 8): Uint8Array => {
  const ihdrLength = 13;
  const actlLength = 8;
  const bytes = new Uint8Array(8 + (12 + ihdrLength) + (12 + actlLength));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, ihdrLength);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  const actl = 8 + 12 + ihdrLength;
  view.setUint32(actl, actlLength);
  bytes.set([0x61, 0x63, 0x54, 0x4c], actl + 4); // acTL
  view.setUint32(actl + 8, 2); // number of frames
  view.setUint32(actl + 12, 0); // number of plays
  return bytes;
};
