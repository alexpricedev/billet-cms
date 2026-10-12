import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Login } from "./login";

// The signed-out form, which is the one a cross-site POST can reach. It renders
// the hidden field from a token and nothing from a null — a page that renders no
// field still has to render the form, because refusing to draw it would turn a
// session that couldn't be created into a blank page rather than a post that
// fails the check.
//
// Sign-in is invite-only, so /login is now the only signed-out auth surface:
// the /signup route and its form are gone.
const withToken = (token: string | null) => render(<Login csrfToken={token} />);

describe("signed-out auth form", () => {
  test("renders the CSRF field inside its form", () => {
    const html = withToken("nonce.atoken");

    expect(html).toContain('action="/login"');
    expect(html).toContain('<input type="hidden" name="_csrf"');
    expect(html).toContain('value="nonce.atoken"');
  });

  test("renders the form but no field when there is no token", () => {
    const html = withToken(null);

    expect(html).toContain('action="/login"');
    expect(html).not.toContain('name="_csrf"');
  });

  test("has no link to a sign-up page", () => {
    expect(withToken("nonce.atoken")).not.toContain('href="/signup"');
  });
});
