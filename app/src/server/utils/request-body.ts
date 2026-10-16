import { MAX_UPLOAD_BYTES } from "@alexpricedev/billet-cms/contract";

/**
 * Multipart framing around the file: the boundary, each part's headers and the
 * form's other fields. It is small and fixed, so a generous constant leaves
 * every legitimate upload under the server-wide ceiling.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * The largest request body the server will read, set as `Bun.serve`'s
 * `maxRequestBodySize`.
 *
 * Bun's default is 128 MB, so without this one request could buffer six times
 * the upload cap before `services/media` ever sees the file. The upload cap
 * (`MAX_UPLOAD_BYTES`) stays the limit the editor is told about; this is the
 * backstop a little above it, high enough that a legitimate multipart upload is
 * never refused here for its framing, and low enough that an oversized body is
 * rejected with a 413 rather than buffered.
 */
export const MAX_REQUEST_BODY_BYTES =
  MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;
