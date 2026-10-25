import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { PageRecord, SlotRecord } from "../../services/content";
import type { User } from "../../services/users";
import { PageHistory } from "./page-history";
import { SlotHistory } from "./slot-history";

const user = { id: "u1", email: "priya@example.com" } as unknown as User;
const slot = { id: "s1", name: "home.hero", label: null } as SlotRecord;
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
    restoredFromAt: new Date("2026-01-11T09:00:00Z"),
  },
  {
    id: "r1",
    createdAt: new Date("2026-01-11T09:00:00Z"),
    authorEmail: "sam@example.com",
    isPublished: false,
    isLatest: false,
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
