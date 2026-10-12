import { AuthPage } from "../components/auth-page";
import { CaptchaWidget } from "../components/captcha-widget";
import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";
import { FormField } from "../components/form-field";
import { Honeypot } from "../components/honeypot";
import type { CaptchaChallenge } from "../services/captcha";

export interface SignupState {
  state?: "email-sent" | "validation-error";
  error?: string;
  email?: string;
}

export interface SignupProps {
  // Bound to this page's POST and to the guest session the GET set a cookie
  // for. Null when no session could be made: the form still renders, and the
  // post it produces fails the check, which is the right answer.
  csrfToken?: string | null;
  state?: SignupState;
  challenge?: CaptchaChallenge | null;
  // Only true under the console email provider. Anywhere else the link really
  // is in an inbox, and the hint sends people to a terminal they can't see.
  showConsoleHint?: boolean;
}

export const Signup = ({
  csrfToken,
  state,
  challenge,
  showConsoleHint,
}: SignupProps) => (
  <AuthPage
    title="Sign up - Billet CMS"
    description="Create a Billet CMS account — we'll email you a link to get started."
    canonicalPath="/signup"
    heading="Create your account"
    subtitle="We'll email you a link to get started — no password needed"
    footer={
      <>
        <a href="/login">Already have an account?</a>
        {" · "}
        <a href="/">Back to home</a>
      </>
    }
  >
    {state?.state === "email-sent" ? (
      <Flash type="success">
        <p>Check your email!</p>
        <p>We've sent you a link to finish setting up your account.</p>
        {showConsoleHint && (
          <p>For testing: Check the server console for the link.</p>
        )}
      </Flash>
    ) : (
      <form method="POST" action="/signup">
        <CsrfField token={csrfToken} />
        {state?.state === "validation-error" && state.error && (
          <Flash type="error">
            <span>{state.error}</span>
          </Flash>
        )}

        <FormField label="Email address" id="email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="Enter your email"
            defaultValue={state?.email}
          />
        </FormField>

        <Honeypot />

        <CaptchaWidget challenge={challenge} />

        <button type="submit" className="login-submit">
          Send sign-up link
        </button>
      </form>
    )}
  </AuthPage>
);
