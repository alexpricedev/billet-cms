/**
 * The shared body of the slot and page Preview endpoints.
 *
 * A preview is one mechanism for both subjects: check the site URL, mint a
 * short-lived token for that one subject, and send the editor to the site with
 * it. The two controllers differ only in the subject they name, the site path
 * they open and the editor page a failure returns to, so the sequence lives here
 * once rather than twice.
 */
import type { PreviewSubjectType } from "@alexpricedev/billet-cms/preview";
import {
  buildPreviewUrl,
  createPreviewToken,
  previewSiteOrigin,
} from "../../services/content";
import { log } from "../../services/logger";
import { redirect } from "../../utils/response";

export interface PreviewRedirectInput {
  subjectType: PreviewSubjectType;
  subjectId: string;
  /** The site path to open: a page's URL, or a slot's declared preview path. */
  path: string;
  /** The identity minting the token, for the audit row. */
  createdBy: string | null;
  /** The editor page a failed preview returns to, with `?preview=failed`. */
  returnTo: string;
}

/**
 * Mint a preview token for one subject and open it on the site.
 *
 * The site URL is resolved before anything is written. `validateEnv` refuses to
 * boot without a valid http(s) `SITE_APP_URL`, so in a running server this can
 * never fail — but checking first means a process that booted outside the server
 * (a unit test, a mis-set variable) sends the editor back with a notice rather
 * than leaving a token nothing can open.
 */
export const previewRedirect = async (
  input: PreviewRedirectInput,
): Promise<Response> => {
  const baseUrl = process.env.SITE_APP_URL;

  if (!previewSiteOrigin(baseUrl)) {
    log.error(
      "preview",
      `SITE_APP_URL is unset or not a URL; cannot open a preview for ${input.subjectType} "${input.subjectId}"`,
    );
    return redirect(`${input.returnTo}?preview=failed`);
  }

  // Minting writes a row, so an unreachable database or a missing
  // `cms_preview_tokens` is the one thing that can fail here. That is a notice,
  // not the styled HTML 500 an uncaught throw would become.
  let rawToken: string;
  try {
    ({ rawToken } = await createPreviewToken({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      createdBy: input.createdBy,
    }));
  } catch (error) {
    log.error(
      "preview",
      `Could not mint a preview token for ${input.subjectType} "${input.subjectId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return redirect(`${input.returnTo}?preview=failed`);
  }

  const url = buildPreviewUrl({ baseUrl, path: input.path, rawToken });
  // The origin was proved above and the path falls back to the site root, so
  // this only fails on a URL the runtime refuses to build; treat it as failed.
  if (!url) {
    log.error(
      "preview",
      `Could not build the preview link for ${input.subjectType} "${input.subjectId}"`,
    );
    return redirect(`${input.returnTo}?preview=failed`);
  }

  return redirect(url);
};
