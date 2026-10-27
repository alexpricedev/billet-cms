import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type {
  BlockTypeRecord,
  PageRecord,
  SlotRecord,
} from "../../services/content";
import type { User } from "../../services/users";
import { PageHistory } from "./page-history";
import { SlotHistory } from "./slot-history";

const user = { id: "u1", email: "priya@example.com" } as unknown as User;
const slot = {
  id: "s1",
  name: "footer.cta",
  page: "footer",
  label: "Footer call to action",
} as SlotRecord;
const hero = { name: "cta" } as BlockTypeRecord;
const page = {
  id: "p1",
  title: "About",
  url: "/about",
} as unknown as PageRecord;

const revisions = [
  {
    id: "r2",
    createdAt: new Date("2026-10-25T08:50:00Z"),
    authorEmail: "priya@example.com",
    isPublished: true,
    isLatest: true,
    isDraft: false,
    restoredFromAt: new Date("2026-01-11T09:00:00Z"),
  },
  {
    id: "r1",
    createdAt: new Date("2026-01-11T09:00:00Z"),
    authorEmail: "sam@example.com",
    isPublished: false,
    isLatest: false,
    isDraft: false,
    restoredFromAt: null,
  },
];

const renders: [string, string][] = [
  [
    "slot",
    renderToString(
      <SlotHistory
        user={user}
        slot={slot}
        blockType={hero}
        revisions={revisions}
        restoreCsrfToken="t"
      />,
    ),
  ],
  [
    "page",
    renderToString(
      <PageHistory
        user={user}
        page={page}
        revisions={revisions}
        restoreCsrfToken="t"
      />,
    ),
  ],
];

describe.each(renders)("%s history", (_name, html) => {
  test("labels a restored row with its source date", () => {
    expect(html).toContain("Restored from 11 Jan 2026");
    expect(html.split("Restored from").length - 1).toBe(1);
  });

  test("dates the Restore button and names the author", () => {
    expect(html).toContain("Restore the 11 Jan version");
    expect(html).toContain(
      'aria-label="Restore the 11 Jan version, saved 11 Jan 2026, 09:00 UTC by sam@example.com as draft"',
    );
  });
});

// Part 4: the header reads like the editor it belongs to, not like a raw key.
describe("history headers", () => {
  const slotHtml = renders[0][1];
  const pageHtml = renders[1][1];

  test("breadcrumbs the slot by its page and its editor-facing title", () => {
    expect(slotHtml).toMatch(
      /<p class="cms-breadcrumb">.*Content<\/a> \/ <span>Footer<\/span> \/ <a href="\/cms\/slots\/s1">Footer call to action<\/a> \/ <span>History<\/span>/,
    );
  });

  test("puts the slot key and block on one muted line", () => {
    expect(slotHtml).toContain(
      '<code>footer.cta</code> · block <code>cta</code>',
    );
    expect(slotHtml).toContain('class="cms-slot-meta"');
  });

  test("still names the block when a deploy removed its type", () => {
    const html = renderToString(
      <SlotHistory
        user={user}
        slot={slot}
        blockType={null}
        revisions={revisions}
        restoreCsrfToken="t"
      />,
    );
    expect(html).toContain("<code>footer.cta</code>");
    expect(html).not.toContain("block <code>");
  });

  test("shows a page's URL as muted metadata, not prose", () => {
    expect(pageHtml).toContain('<p class="cms-slot-meta"><code>/about</code></p>');
    expect(pageHtml).not.toContain("Page <code>");
  });
});
