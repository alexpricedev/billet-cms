/**
 * Identify an upload from its own bytes, and read its size without decoding it.
 *
 * A browser-declared MIME type is not evidence: `File.type` is an extension
 * guess the client chooses, so a script could POST an SVG as `image/png`. The
 * magic bytes are what the file actually is, and everything the media service
 * decides — accept or refuse, which decoder, which pixel cap — hangs off this
 * one read.
 *
 * The dimensions are parsed from the header here, before Sharp sees the file,
 * so a decompression bomb is refused before a decode allocates anything. Each
 * parser reads only the fixed header fields it needs and returns `null` rather
 * than guessing when the structure doesn't match.
 */
import type { AllowedUploadType } from "@alexpricedev/billet-cms/contract";

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "svg";

export interface ImageSize {
  width: number;
  height: number;
}

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length &&
  signature.every((byte, index) => bytes[index] === byte);

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return out;
};

/** Read a big-endian 16-bit integer. */
const uint16be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

/** Read a little-endian 16-bit integer. */
const uint16le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

/** Read a big-endian 32-bit integer. */
const uint32be = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

/** Read a little-endian 24-bit integer. */
const uint24le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

/**
 * What the bytes are, or `null` when they aren't a format we recognise.
 *
 * WebP is checked after RIFF/WEBP because a plain RIFF container is not an
 * image; SVG is last and textual, so a JPEG whose first bytes happen to look
 * like text can never be mistaken for one.
 */
export const sniffImageFormat = (bytes: Uint8Array): ImageFormat | null => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
};

/**
 * True for a document whose first non-space bytes open an `<svg>` element.
 *
 * The check is deliberately shallow: it only has to separate "this is SVG"
 * from the binaries above, and the accepted set is a positive list, so a
 * missed SVG is refused as an unknown type rather than waved through.
 */
const looksLikeSvg = (bytes: Uint8Array): boolean => {
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml");
};

/**
 * The pixel dimensions of a recognised format, read from its header.
 *
 * `null` when the header is short or malformed; the caller refuses the upload
 * rather than passing it to a decoder on a guess.
 */
export const readImageSize = (
  bytes: Uint8Array,
  format: ImageFormat,
): ImageSize | null => {
  switch (format) {
    case "png":
      return readPngSize(bytes);
    case "jpeg":
      return readJpegSize(bytes);
    case "webp":
      return readWebpSize(bytes);
    case "gif":
      return bytes.length >= 10
        ? { width: uint16le(bytes, 6), height: uint16le(bytes, 8) }
        : null;
    case "svg":
      // An SVG has no fixed raster size we can trust before rendering it.
      return null;
  }
};

const readPngSize = (bytes: Uint8Array): ImageSize | null => {
  // 8 signature bytes, then the IHDR chunk: length(4) type(4) width(4) height(4).
  if (bytes.length < 24) return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
};

const readJpegSize = (bytes: Uint8Array): ImageSize | null => {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1] ?? 0;
    // Skip any run of 0xFF fill bytes before the marker code.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }

    // Standalone markers carry no length; the scan-data marker ends the header.
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;

    const length = uint16be(bytes, offset + 2);
    if (length < 2) return null;
    // SOF0–SOF15 give the frame's size; C4 (Huffman), C8 (JPEG extensions) and
    // CC (arithmetic coding) share the range but are not frame headers.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: uint16be(bytes, offset + 5),
        width: uint16be(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
};

const readWebpSize = (bytes: Uint8Array): ImageSize | null => {
  // 12 bytes of RIFF header, then a fourcc and its 4-byte chunk size; the
  // payload starts at 20.
  if (bytes.length < 30) return null;
  const fourcc = ascii(bytes, 12, 4);

  if (fourcc === "VP8 ") {
    // Lossy: 3-byte frame tag, the 0x9d 0x01 0x2a sync code, then 14-bit each.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return {
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff,
    };
  }

  if (fourcc === "VP8L") {
    // Lossless: a 0x2f signature then two 14-bit values packed little-endian.
    if (bytes[20] !== 0x2f) return null;
    const bits = uint24le(bytes, 21) + ((bytes[24] ?? 0) << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (fourcc === "VP8X") {
    return {
      width: uint24le(bytes, 24) + 1,
      height: uint24le(bytes, 27) + 1,
    };
  }

  return null;
};

/** The MIME type the accepted source formats carry. */
export const contentTypeFor = (format: ImageFormat): AllowedUploadType => {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
};

/** The file extension the accepted source formats are stored under. */
export const extensionFor = (format: ImageFormat): string => {
  if (format === "jpeg") return "jpg";
  if (format === "png") return "png";
  return "webp";
};
