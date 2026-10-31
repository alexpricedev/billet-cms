/**
 * The upload half of the client's third exception (AGENTS.md).
 *
 * The image picker and the Media page's staged tiles both send one file to
 * `POST /cms/media` as JSON with upload progress, so the wire format lives here
 * once: the multipart body, the CSRF header (and the retry that spends a fresh
 * token when the page's one has expired), the `Accept` header that asks for
 * JSON, and the parse of the answer. They differ in what they do around it — the
 * picker uploads as soon as a file arrives, the Media page waits for alt text —
 * and that stays in each entry point.
 *
 * Together with `image-picker.ts` this file is allowed `XMLHttpRequest` and
 * `JSON.parse` by `boundaries.test.ts`, and it talks to no route but
 * `POST /cms/media`. It builds no markup.
 */

import { CSRF_FIELD, CSRF_HEADER } from "@shared/protocol";

/** One upload as the media routes return it. */
export interface MediaOption {
  id: string;
  alt: string;
  width: number;
  height: number;
  /** Null when the upload has no rendition the card can show. */
  thumbnailUrl: string | null;
}

export type UploadResult =
  | { ok: true; option: MediaOption }
  | { ok: false; message: string };

export const isOption = (value: unknown): value is MediaOption => {
  if (typeof value !== "object" || value === null) return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.id === "string" &&
    typeof option.alt === "string" &&
    typeof option.width === "number" &&
    typeof option.height === "number"
  );
};

/** The first issue's message, or the fallback when the body doesn't name one. */
export const messageFrom = (body: unknown): string => {
  if (typeof body === "object" && body !== null) {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const first = errors.find(
        (error): error is { message: string } =>
          typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string",
      );
      if (first) return first.message;
    }
  }
  return "Couldn't upload this file.";
};

/** A local preview of a file being uploaded, with the URL to release afterwards. */
export interface UploadPreview {
  image: HTMLImageElement;
  url: string;
}

export const imagePreview = (file: File): UploadPreview | null => {
  if (typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  return { image, url };
};

/** Release a preview's object URL once the tile shows something else. */
export const revokePreview = (preview: UploadPreview | null): void => {
  if (preview && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(preview.url);
  }
};

export interface UploadFileRequest {
  file: File;
  alt: string;
  /** The page's token; the answer carries the current one after a refresh. */
  token: string;
  onProgress?: (percent: number) => void;
}

export interface UploadAnswer {
  result: UploadResult;
  /** Fresh when the server replaced an expired token, otherwise the one sent. */
  token: string;
}

/** Send one file, resolving with the answer and the token now in play. */
export const uploadFile = ({
  file,
  alt,
  token,
  onProgress,
}: UploadFileRequest): Promise<UploadAnswer> =>
  new Promise<UploadAnswer>((resolve) => {
    const send = (csrfToken: string, allowRetry: boolean): void => {
      const form = new FormData();
      form.append(CSRF_FIELD, csrfToken);
      form.append("alt", alt);
      form.append("file", file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/cms/media");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader(CSRF_HEADER, csrfToken);

      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      });

      xhr.addEventListener("load", () => {
        // The page's upload token can be older than the page by the time the
        // file is sent. The server answers an expired-but-authentic token with
        // a fresh one in the CSRF header; spend it once rather than making the
        // editor reload and lose what they typed.
        if (
          xhr.status === 403 &&
          allowRetry &&
          typeof xhr.getResponseHeader === "function"
        ) {
          const fresh = xhr.getResponseHeader(CSRF_HEADER);
          if (fresh) {
            send(fresh, false);
            return;
          }
        }
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && isOption(body)) {
          resolve({ result: { ok: true, option: body }, token: csrfToken });
          return;
        }
        resolve({
          result: { ok: false, message: messageFrom(body) },
          token: csrfToken,
        });
      });

      xhr.addEventListener("error", () =>
        resolve({
          result: {
            ok: false,
            message:
              "Couldn't upload this file. Check the connection and try again.",
          },
          token: csrfToken,
        }),
      );

      xhr.send(form);
    };

    send(token, true);
  });
