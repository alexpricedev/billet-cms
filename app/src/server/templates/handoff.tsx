import { AuthPage } from "../components/auth-page";
import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";

export const HANDOFF_PATH = "/handoff";

export interface HandoffProps {
  token: string;
  // Null means no session could be started, which is a dead end worth naming.
  csrfToken: string | null;
}

/**
 * The confirm step between the site's Edit content link and the CMS session it
 * starts.
 *
 * Both the site's Edit content link and CMS sign-in land here, and both carry a
 * single-use token, so the GET only shows the button and the POST spends it. A
 * token that a browser prefetch or a link scanner could burn by fetching the URL
 * would leave the person staring at an expired link with nothing to explain it;
 * a GET that answers with a form is inert.
 */
export const Handoff = ({ token, csrfToken }: HandoffProps) => {
  return (
    <AuthPage
      title="Edit content - Billet CMS"
      description="Continue to Billet CMS to edit the site's content."
      canonicalPath={HANDOFF_PATH}
      heading="Edit content"
      subtitle="You'll be signed in to Billet CMS"
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
        <form method="POST" action={HANDOFF_PATH}>
          <CsrfField token={csrfToken} />
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="login-submit">
            Continue
          </button>
        </form>
      )}
    </AuthPage>
  );
};
