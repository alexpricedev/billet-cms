import { AuthPage } from "../components/auth-page";
import { CaptchaWidget } from "../components/captcha-widget";
import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";
import { FormField } from "../components/form-field";
import { Honeypot } from "../components/honeypot";
import type { CaptchaChallenge } from "../services/captcha";
import type { FlashMessage } from "../utils/flash";

export interface LoginState {
  state?: "email-sent" | "validation-error";
  error?: string;
  // Preserved across the redirect so a failed attempt doesn't make the user
  // retype their address.
  email?: string;
}

export interface LoginProps {
  // Bound to this page's POST and to the guest session the GET set a cookie
  // for. Null when no session could be made: the form still renders, and the
  // post it produces fails the check, which is the right answer.
  csrfToken?: string | null;
  state?: LoginState;
  challenge?: CaptchaChallenge | null;
  // The cross-page "message" flash, not this page's own state: something
  // finished elsewhere and sent them here to sign in.
  message?: FlashMessage;
  // Only true under the console email provider. Anywhere else the link really
  // is in an inbox, and the hint sends people to a terminal they can't see.
  showConsoleHint?: boolean;
}

export const Login = ({
  csrfToken,
  state,
  challenge,
  message,
  showConsoleHint,
}: LoginProps) => {
  return (
    <AuthPage
      title="Login - Billet CMS"
      description="Log in to Billet CMS with a magic link — no passwords to remember."
      canonicalPath="/login"
      heading="Sign in to your account"
      subtitle="We'll send you a magic link to sign in instantly"
    >
      {message && (
        <Flash type={message.type}>
          <span>{message.text}</span>
        </Flash>
      )}

      {state?.state === "email-sent" ? (
        <Flash type="success">
          <p>Check your email!</p>
          <p>We've sent you a magic link. Click it to sign in instantly.</p>
          {showConsoleHint && (
            <p>For testing: Check the server console for the magic link.</p>
          )}
        </Flash>
      ) : (
        <form method="POST" action="/login">
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
            Send magic link
          </button>
        </form>
      )}
    </AuthPage>
  );
};
