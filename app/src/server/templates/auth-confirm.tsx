import { AuthPage } from "../components/auth-page";
import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";

export const CALLBACK_PATH = "/auth/callback";

export interface AuthConfirmProps {
  token: string;
  // Null means no session could be started, which is a dead end worth naming.
  csrfToken: string | null;
}

/**
 * The click-to-continue step between a single-use link and the thing it spends.
 *
 * Corporate mail filters (Microsoft Defender Safe Links and friends) fetch
 * every link they deliver, and a fetch is enough to burn a single-use token —
 * so the recipient clicks a link that has already been spent and lands on a
 * page that can't explain why. Redemption therefore happens on this form's
 * POST: scanners follow links, they don't submit forms.
 *
 * The POST is CSRF-checked, because a cross-site auto-submit would be login
 * CSRF — dropping a visitor into a session they didn't ask for.
 */
export const AuthConfirm = ({ token, csrfToken }: AuthConfirmProps) => {
  return (
    <AuthPage
      title="Confirm sign in - Billet CMS"
      description="Finish signing in to Billet CMS."
      canonicalPath={CALLBACK_PATH}
      heading="Confirm sign in"
      subtitle="Your link works once, so we ask before spending it"
      footer={<a href="/">Back to home</a>}
    >
      {!csrfToken ? (
        <Flash type="error">
          <span>
            We couldn't start a session in your browser. Check that cookies are
            enabled and open the link again.
          </span>
        </Flash>
      ) : (
        <form method="POST" action={CALLBACK_PATH}>
          <CsrfField token={csrfToken} />
          {/* In the body rather than the action URL, so it stays out of the
              Referer header when a browser follows a link off this page. */}
          <input type="hidden" name="token" value={token} />

          <button type="submit" className="login-submit">
            Sign in
          </button>
        </form>
      )}
    </AuthPage>
  );
};
