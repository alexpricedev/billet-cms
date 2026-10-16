import type { BunRequest } from "bun";
import { redirect } from "../../utils/response";

/**
 * The CMS root. There is no marketing page of the CMS's own: send the bare
 * origin to the CMS surface at `/cms`. That route is guarded, so a signed-out
 * visitor is handed to `/sign-in` and on to the site's own sign-in route — see
 * `controllers/auth/sign-in.tsx` and the plugin's `handleCmsSignIn`.
 */
export const landing = {
  index(_req: BunRequest): Response {
    return redirect("/cms");
  },
};
