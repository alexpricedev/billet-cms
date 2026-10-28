import { AuthPage } from "../components/auth-page";
import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";
import { SITE_NAME } from "../services/seo";

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
      title={`Sign in - ${SITE_NAME}`}
      description={`Continue to ${SITE_NAME} to edit the site's content.`}
      canonicalPath={HANDOFF_PATH}
      heading={`Sign in to ${SITE_NAME}`}
      subtitle="Confirm to open the editor"
      footer={null}
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
          <button type="submit" className="btn btn-primary login-submit">
            Continue to {SITE_NAME}
          </button>
        </form>
      )}
    </AuthPage>
  );
};

interface HandoffGoneProps {
  siteUrl: string | null;
}

const BackToSite = ({ siteUrl }: HandoffGoneProps) =>
  siteUrl ? <a href={siteUrl}>Back to the site</a> : null;

/**
 * A handoff link that was already used, has timed out or never existed. The
 * three read the same to the visitor: the way forward is a fresh Edit content
 * link from the site.
 */
export const HandoffExpired = ({ siteUrl }: HandoffGoneProps) => (
  <AuthPage
    title={`Link expired - ${SITE_NAME}`}
    description="This Edit content link can't be used again."
    canonicalPath={HANDOFF_PATH}
    heading="This link has already been used or has expired"
    subtitle="Go back to the site and tap Edit content again to get a new one."
    footer={<BackToSite siteUrl={siteUrl} />}
  />
);

/** The link was fine but the site no longer lists the person as an editor. */
export const HandoffNoAccount = ({ siteUrl }: HandoffGoneProps) => (
  <AuthPage
    title={`Can't sign in - ${SITE_NAME}`}
    description="This account can no longer sign in to the CMS."
    canonicalPath={HANDOFF_PATH}
    heading="This account can no longer sign in"
    subtitle="Ask a site admin for access to the editor."
    footer={<BackToSite siteUrl={siteUrl} />}
  />
);
