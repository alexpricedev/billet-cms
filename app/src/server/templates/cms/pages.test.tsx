import { describe, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type {
  PageGroup,
  PageRecord,
  PageTypeRecord,
} from "../../services/content";
import type { User } from "../../services/users";
import { PagesList } from "./pages";

const user = { id: "u1", email: "priya@example.com" } as unknown as User;

const page = (
  overrides: Pick<PageRecord, "id" | "title" | "url" | "pageType"> &
    Partial<PageRecord>,
): PageRecord => ({
  draftUrl: null,
  seoDescription: null,
  socialImageId: null,
  publishedRevisionId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const harbour = page({
  id: "p2",
  title: "Harbour",
  url: "/case-study-harbour",
  pageType: "landing",
  publishedRevisionId: "r1",
});
const tides = page({
  id: "p3",
  title: "Tides",
  url: "/journal/one",
  pageType: "article",
});
const about = page({
  id: "p1",
  title: "About us",
  url: "/about",
  pageType: "landing",
});

const groups: PageGroup[] = [
  {
    kind: "section",
    key: "case-studies",
    label: "Case studies",
    pages: [harbour],
  },
  { kind: "section", key: "journal", label: "Journal", pages: [tides] },
  { kind: "pageType", key: "landing", label: "Landing", pages: [about] },
];

const pageTypes: PageTypeRecord[] = [
  {
    id: "pt1",
    name: "landing",
    label: null,
    help: null,
    allowedBlocks: [],
    requiredBlocks: [],
    limits: {},
    jsonSchema: {},
    removedAt: null,
  },
];

const render = (props: Partial<Parameters<typeof PagesList>[0]> = {}) =>
  renderToString(
    <PagesList
      user={user}
      pages={[harbour, tides, about]}
      groups={groups}
      pageTypes={pageTypes}
      redirects={[]}
      {...props}
    />,
  );

const headings = (html: string): string[] =>
  [...html.matchAll(/<h2 class="cms-page-group-heading">([^<]*)<\/h2>/g)].map(
    (match) => match[1],
  );

describe("PagesList", () => {
  test("renders the group headings in the order it is given", () => {
    expect(headings(render())).toEqual(["Case studies", "Journal", "Landing"]);
  });

  test("renders each page's row inside its group, unchanged", () => {
    const html = render();

    expect(html).toContain(
      '<a class="cms-page-link" href="/cms/pages/p2">Harbour</a>',
    );
    expect(html).toContain("<code>/case-study-harbour</code>");
    expect(html).toContain('<span class="cms-page-type">landing</span>');
    expect(html).toContain("Published");

    expect(html).toContain(
      '<a class="cms-page-link" href="/cms/pages/p3">Tides</a>',
    );
    expect(html).toContain('<span class="cms-page-type">article</span>');
    expect(html).toContain("Draft");

    // A page under a section heading stays there; the fallback group follows.
    expect(html.indexOf("Harbour")).toBeLessThan(html.indexOf("Tides"));
    expect(html.indexOf("Tides")).toBeLessThan(html.indexOf("About us"));
  });

  test("keeps the redirects and page types sections after the groups", () => {
    const html = render();

    expect(html).toContain("<h2>Redirects</h2>");
    expect(html).toContain("<h2>Page types</h2>");
    expect(html.indexOf("cms-page-groups")).toBeLessThan(
      html.indexOf("<h2>Redirects</h2>"),
    );
  });

  test("still shows the empty state when there are no pages", () => {
    const html = render({ pages: [], groups: [] });

    expect(html).toContain("No pages yet.");
    expect(headings(html)).toEqual([]);
  });
});
