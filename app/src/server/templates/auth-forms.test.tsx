import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Login } from "./login";
import { Signup } from "./signup";

// The signed-out forms, which are the ones a cross-site POST can reach. They
// render the hidden field from a token and nothing from a null — a page that
// renders no field still has to render the form, because refusing to draw it
// would turn a session that couldn't be created into a blank page rather than a
// post that fails the check.
const forms = [
  {
    name: "Login",
    action: "/login",
    withToken: (token: string | null) => render(<Login csrfToken={token} />),
  },
  {
    name: "Signup",
    action: "/signup",
    withToken: (token: string | null) => render(<Signup csrfToken={token} />),
  },
];

describe("signed-out auth forms", () => {
  for (const { name, action, withToken } of forms) {
    describe(name, () => {
      test("renders the CSRF field inside its form", () => {
        const html = withToken("nonce.atoken");

        expect(html).toContain(`action="${action}"`);
        expect(html).toContain('<input type="hidden" name="_csrf"');
        expect(html).toContain('value="nonce.atoken"');
      });

      test("renders the form but no field when there is no token", () => {
        const html = withToken(null);

        expect(html).toContain(`action="${action}"`);
        expect(html).not.toContain('name="_csrf"');
      });
    });
  }
});
