/**
 * Turn an accepted upload into the renditions the library stores.
 *
 * Two things happen here that the spec calls out by name:
 *
 * 1. **EXIF rotation is applied, then metadata is stripped.** `rotate()` with
 *    no arguments reads the EXIF orientation tag and bakes the rotation into
 *    the pixels; Sharp drops all metadata (EXIF, GPS, colour profiles) by
 *    default, so the output carries none of the original's. That is why a
 *    photo taken sideways renders upright and a photo taken at home carries no
 *    coordinates — the two are one pipeline, not two passes.
 * 2. **Every width is covered, never an upscale.** The fixed ladder
 *    (`MEDIA_WIDTHS`) is filtered to what the source can actually fill, with
 *    the source's own width added when it exceeds the widest fixed rung, so a
 *    small image isn't stretched and a large one still has a full-size
 *    rendition. The site builds its `srcset` from whatever came back.
 *
 * The fallback format follows the source: a PNG keeps its alpha in a PNG
 * fallback, everything else falls back to JPEG. WebP is the primary rendition
 * either way.
 */
import {
  MAX_UPLOAD_PIXELS,
  MEDIA_WIDTHS,
} from "@alexpricedev/billet-cms/contract";
import sharp from "sharp";
import { extensionFor, type ImageFormat } from "./sniff";

/** Visual quality for the lossy encodings. Chunky enough for the web, clean at 2x. */
const WEBP_QUALITY = 82;
const JPEG_QUALITY = 82;

export interface ProcessedRendition {
  width: number;
  height: number;
  webp: Uint8Array;
  /** JPEG, or PNG when the source was a PNG. */
  fallback: Uint8Array;
}

export interface ProcessedImage {
  /** The source's own size once EXIF rotation is applied. */
  width: number;
  height: number;
  /** A full-size, metadata-stripped re-encode of the source. */
  original: {
    contentType: string;
    extension: string;
    bytes: Uint8Array;
  };
  renditions: ProcessedRendition[];
}

/**
 * The widths a source of this size gets, ascending, deduplicated.
 *
 * Only widths the source can fill: never an upscale. A source narrower than the
 * smallest fixed rung gets exactly one rendition at its own width, so there is
 * always something to render.
 */
export const renditionWidths = (sourceWidth: number): number[] => {
  const fixed: number[] = MEDIA_WIDTHS.filter((width) => width < sourceWidth);
  const widestFixed = fixed.length > 0 ? fixed[fixed.length - 1] : 0;
  const widths = [...fixed];
  if (sourceWidth > widestFixed) widths.push(sourceWidth);
  return [...new Set(widths)].sort((a, b) => a - b);
};

/** A sharp pipeline, as the helpers below take it. */
type SharpImage = ReturnType<typeof sharp>;

/** The fallback encoding for a source: PNG keeps its alpha, everything else is JPEG. */
const fallbackFormat = (format: ImageFormat): "png" | "jpeg" =>
  format === "png" ? "png" : "jpeg";

/** Encode a pipeline as WebP, returning the bytes and the output dimensions. */
const encodeWebp = async (
  image: SharpImage,
): Promise<{ bytes: Uint8Array; width: number; height: number }> => {
  const { data, info } = await image
    .clone()
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
};

const encodeFallback = async (
  image: SharpImage,
  format: "png" | "jpeg",
): Promise<{ bytes: Uint8Array; width: number; height: number }> => {
  const pipeline =
    format === "png"
      ? image.clone().png({ compressionLevel: 9 })
      : image.clone().jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
};

/** Encode the full-size original in its own format, without metadata. */
const encodeOriginal = async (
  image: SharpImage,
  format: ImageFormat,
): Promise<{ bytes: Uint8Array; width: number; height: number }> => {
  const pipeline =
    format === "png"
      ? image.clone().png({ compressionLevel: 9 })
      : format === "webp"
        ? image.clone().webp({ quality: WEBP_QUALITY })
        : image.clone().jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
};

/**
 * Build every rendition of an upload.
 *
 * Throws when Sharp can't read the bytes; the media service turns that into an
 * editor-facing "we couldn't read that image" rather than a 500.
 */
export const processImage = async (
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<ProcessedImage> => {
  // `rotate()` bakes in EXIF orientation; nothing asks Sharp to keep metadata,
  // so EXIF (GPS included) is stripped from every output below. The pixel limit
  // repeats the header check in the media service as a backstop: it makes Sharp
  // refuse a decode that would allocate more than the cap even if a header lied.
  const source = sharp(bytes, {
    failOn: "error",
    limitInputPixels: MAX_UPLOAD_PIXELS,
  }).rotate();
  const original = await encodeOriginal(source, format);

  const renditions: ProcessedRendition[] = [];
  for (const width of renditionWidths(original.width)) {
    const resized = source.clone().resize({ width, withoutEnlargement: true });
    const webp = await encodeWebp(resized);
    const fallback = await encodeFallback(resized, fallbackFormat(format));
    renditions.push({
      width: fallback.width,
      height: fallback.height,
      webp: webp.bytes,
      fallback: fallback.bytes,
    });
  }

  return {
    width: original.width,
    height: original.height,
    original: {
      contentType:
        format === "png"
          ? "image/png"
          : format === "webp"
            ? "image/webp"
            : "image/jpeg",
      extension: extensionFor(format),
      bytes: original.bytes,
    },
    renditions,
  };
};
