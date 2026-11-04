import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { HandoffExpired, HandoffNoAccount } from "./handoff";

const SITE_URL = "https://site.example.com";

/** The card's own markup, so "inside the card" is what the test asserts. */
const cardOf = (html: string) => {
  const start = html.indexOf('class="login-card"');
  const end = html.indexOf("</div>", start);
  return html.slice(start, end);
};

describe("HandoffExpired", () => {
  test("puts Back to the site inside the card, as a button", () => {
    const html = renderToString(<HandoffExpired siteUrl={SITE_URL} />);
    const card = cardOf(html);

    expect(card).toContain(`href="${SITE_URL}"`);
    expect(card).toContain("btn btn-secondary login-submit");
    expect(card).toContain("Back to the site");
    // The old grey line under the card is gone.
    expect(html).not.toContain('class="login-footer"');
  });

  test("renders nothing at all without a site URL", () => {
    const html = renderToString(<HandoffExpired siteUrl={null} />);
    const card = cardOf(html);

    expect(html).not.toContain("Back to the site");
    expect(html).not.toContain('class="login-footer"');
    // The subtitle is the card's last child, so its margin cannot leave a
    // blank band under it (pinned by the `:last-child` rule in login.css).
    expect(card.trimEnd().endsWith("</p>")).toBe(true);
  });
});

describe("HandoffNoAccount", () => {
  test("gets the same in-card button", () => {
    const html = renderToString(<HandoffNoAccount siteUrl={SITE_URL} />);
    const card = cardOf(html);

    expect(card).toContain(`href="${SITE_URL}"`);
    expect(card).toContain("btn btn-secondary login-submit");
    expect(html).not.toContain('class="login-footer"');
  });

  test("renders nothing at all without a site URL", () => {
    const html = renderToString(<HandoffNoAccount siteUrl={null} />);

    expect(html).not.toContain("Back to the site");
    expect(html).not.toContain('class="login-footer"');
  });
});
