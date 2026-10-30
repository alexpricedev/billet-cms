import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Flash, type FlashTone } from "./flash";

const tones: Array<{ tone: FlashTone; role: "status" | "alert" }> = [
  { tone: "success", role: "status" },
  { tone: "info", role: "status" },
  { tone: "warning", role: "status" },
  { tone: "error", role: "alert" },
];

describe("Flash", () => {
  for (const { tone, role } of tones) {
    test(`renders the ${tone} tone as role="${role}"`, () => {
      const html = renderToString(<Flash tone={tone} title="Draft saved." />);

      expect(html).toContain('class="flash"');
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(`role="${role}"`);
    });
  }

  test("marks both icons aria-hidden", () => {
    const html = renderToString(
      <Flash tone="success" title="Draft saved." dismissible />,
    );

    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  test("renders a title, detail, actions and field links", () => {
    const html = renderToString(
      <Flash
        tone="error"
        title="Couldn't save draft."
        detail="Fix these 2 fields and try again:"
        actions={[
          { href: "/cms/pages/1/preview", label: "Preview draft ↗" },
          {
            href: "https://example.com/spring",
            label: "View page ↗",
            newTab: true,
          },
        ]}
        fields={[
          { id: "cms-field-heading", label: "Heading" },
          { id: "cms-field-body", label: "Body" },
        ]}
      />,
    );

    expect(html).toContain('class="flash-title"');
    expect(html).toContain("save draft.");
    expect(html).toContain('class="flash-detail"');
    expect(html).toContain("Fix these 2 fields and try again:");
    expect(html).toContain('class="flash-actions"');
    expect(html).toContain('href="/cms/pages/1/preview"');
    expect(html).toContain('href="https://example.com/spring"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('class="flash-fields"');
    expect(html).toContain('href="#cms-field-heading"');
    expect(html).toContain("Heading");
    expect(html).toContain('href="#cms-field-body"');
  });

  test("renders a field with no control to link to as plain text", () => {
    const html = renderToString(
      <Flash
        tone="error"
        title="Couldn't save draft."
        fields={[{ label: "The page needs a hero block." }]}
      />,
    );

    expect(html).toContain("<li>The page needs a hero block.</li>");
    expect(html).not.toContain('href="#');
  });

  test("without dismissible, ships no dismiss button at all", () => {
    const html = renderToString(<Flash tone="info" title="Draft saved." />);

    expect(html).not.toContain('class="flash-dismiss"');
    expect(html).not.toContain("data-flash-dismiss");
    expect(html).not.toContain('aria-label="Dismiss"');
  });

  test("with dismissible, ships the dismiss button hidden and labelled", () => {
    const html = renderToString(
      <Flash tone="info" title="Draft saved." dismissible />,
    );

    expect(html).toContain('class="flash-dismiss"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain("data-flash-dismiss");
    expect(html).toContain('type="button"');
    // The script reveals it; without JavaScript the banner has no × at all.
    expect(html).toMatch(/data-flash-dismiss[^>]*hidden/);
  });

  test("renders extra body markup after the detail line", () => {
    const html = renderToString(
      <Flash tone="warning" title="Copy this token now.">
        <p>
          <code data-export-token>abc123</code>
        </p>
      </Flash>,
    );

    expect(html).toContain('class="flash-body"');
    expect(html).toContain('<code data-export-token="true">abc123</code>');
  });
});
