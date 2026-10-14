import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { User } from "../services/users";
import { Nav } from "./nav";

const user: User = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "member@example.com",
  role: "user",
};

describe("Nav", () => {
  test("ships the mobile toggle hidden and collapsed", () => {
    const html = renderToString(<Nav page="home" user={null} />);

    // Hidden until src/client/components/nav-menu.ts takes over — a page
    // without that script must not render a button that toggles nothing.
    expect(html).toContain("hidden");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="nav-menu"');
    expect(html).toContain('id="nav-menu"');
  });

  test("collects the pages and the auth actions into one panel", () => {
    const html = renderToString(
      <Nav page="home" user={user} csrfToken="tok" />,
    );
    // Everything the toggle reveals lives inside the wrapper; only the button
    // itself is left outside it.
    const panel = html.slice(html.indexOf('id="nav-menu"'));

    expect(panel).toContain('href="/forms"');
    expect(panel).toContain('href="/account"');
    expect(panel).toContain('action="/auth/logout"');
    // The label matches /account's wording rather than upstream's "Logout".
    expect(panel).toContain("Sign out");
    expect(panel).not.toContain("Logout");
    expect(html.slice(0, html.indexOf('id="nav-menu"'))).toContain(
      "nav-toggle",
    );
  });

  test("shows Sign in instead when signed out", () => {
    const html = renderToString(<Nav page="home" user={null} />);

    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain('href="/account"');
  });

  test("marks the current page on its link", () => {
    const html = renderToString(<Nav page="forms" user={null} />);

    expect(html).toContain('aria-current="page"');
  });
});
