import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";
import { jsonbValue } from "../../utils/sql";
import type { PageTypeRecord } from "./definitions";
import type { PageRecord } from "./pages";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "../database";
import {
  groupPages,
  listSections,
  matchesPattern,
  type SectionRecord,
} from "./sections";

const page = (url: string, pageType = "article"): PageRecord => ({
  id: url,
  pageType,
  url,
  draftUrl: null,
  title: url,
  seoDescription: null,
  socialImageId: null,
  publishedRevisionId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const section = (
  name: string,
  paths: string[],
  options: {
    label?: string;
    position?: number;
    removedAt?: Date | null;
  } = {},
): SectionRecord => ({
  id: name,
  name,
  label: options.label ?? null,
  paths,
  position: options.position ?? 0,
  removedAt: options.removedAt ?? null,
});

const pageTypeRecord = (
  name: string,
  label: string | null = null,
): PageTypeRecord => ({
  id: name,
  name,
  label,
  help: null,
  allowedBlocks: [],
  requiredBlocks: [],
  limits: {},
  jsonSchema: {},
  removedAt: null,
});

describe("matchesPattern", () => {
  test("* matches within one segment and no further", () => {
    expect(matchesPattern("/case-study-*", "/case-study-harbour")).toBe(true);
    expect(matchesPattern("/case-study-*", "/case-study/harbour")).toBe(false);
    expect(matchesPattern("/*", "/about")).toBe(true);
    expect(matchesPattern("/*", "/about/team")).toBe(false);
  });

  test("** matches across any number of segments", () => {
    expect(matchesPattern("/journal/**", "/journal/spring-launch")).toBe(true);
    expect(matchesPattern("/journal/**", "/journal/2026/tides")).toBe(true);
    expect(matchesPattern("/journal/**", "/journal/2026/01/tides")).toBe(true);
    // The pattern has a slash of its own, so the bare path is a separate entry.
    expect(matchesPattern("/journal/**", "/journal")).toBe(false);
    expect(matchesPattern("/journal/**", "/journalx/tides")).toBe(false);
  });

  test("literal characters match exactly and are escaped", () => {
    expect(matchesPattern("/journal", "/journal")).toBe(true);
    expect(matchesPattern("/journal", "/journal/2026")).toBe(false);
    expect(matchesPattern("/journal", "/journal/")).toBe(false);
    expect(matchesPattern("/about", "x/about")).toBe(false);
    expect(matchesPattern("/about", "/about/team")).toBe(false);
    // A dot or plus in a path is a literal, not a regex operator.
    expect(matchesPattern("/v1.0", "/v1.0")).toBe(true);
    expect(matchesPattern("/v1.0", "/v1x0")).toBe(false);
    expect(matchesPattern("/a+b", "/a+b")).toBe(true);
    expect(matchesPattern("/a+b", "/aaab")).toBe(false);
  });
});

describe("groupPages", () => {
  test("groups under sections in config order, then page types by name", () => {
    const pages = [
      page("/work", "landing"),
      page("/journal/two"),
      page("/case-study-harbour"),
      page("/about", "landing"),
      page("/journal/one"),
      page("/draft-ideas"),
    ];
    const sections = [
      section("journal", ["/journal", "/journal/**"], {
        label: "Journal",
        position: 1,
      }),
      section("case-studies", ["/case-study-*"], {
        label: "Case studies",
        position: 0,
      }),
    ];
    const pageTypes = [
      pageTypeRecord("landing", "Landing"),
      pageTypeRecord("article", "Article"),
    ];

    expect(groupPages(pages, sections, pageTypes)).toEqual([
      {
        kind: "section",
        key: "case-studies",
        label: "Case studies",
        pages: [page("/case-study-harbour")],
      },
      {
        kind: "section",
        key: "journal",
        label: "Journal",
        pages: [page("/journal/one"), page("/journal/two")],
      },
      {
        kind: "pageType",
        key: "article",
        label: "Article",
        pages: [page("/draft-ideas")],
      },
      {
        kind: "pageType",
        key: "landing",
        label: "Landing",
        pages: [page("/about", "landing"), page("/work", "landing")],
      },
    ]);
  });

  test("the first matching section wins", () => {
    const sections = [
      section("first", ["/journal/**"], { position: 0 }),
      section("second", ["/journal/2026/**"], { position: 1 }),
    ];

    const groups = groupPages([page("/journal/2026/tides")], sections, [
      pageTypeRecord("article"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("first");
  });

  test("a page matching no section falls back to its page type", () => {
    const groups = groupPages(
      [page("/journal/one"), page("/about", "landing")],
      [section("journal", ["/journal/**"])],
      [
        pageTypeRecord("article", "Article"),
        pageTypeRecord("landing", "Landing"),
      ],
    );

    expect(groups.map((group) => [group.kind, group.key])).toEqual([
      ["section", "journal"],
      ["pageType", "landing"],
    ]);
  });

  test("with no sections every page groups by page type", () => {
    const groups = groupPages(
      [page("/about", "landing"), page("/draft", "article")],
      [],
      [
        pageTypeRecord("article", "Article"),
        pageTypeRecord("landing", "Landing"),
      ],
    );

    expect(
      groups.map((group) => [group.kind, group.key, group.pages.length]),
    ).toEqual([
      ["pageType", "article", 1],
      ["pageType", "landing", 1],
    ]);
  });

  test("empty groups are hidden", () => {
    const groups = groupPages(
      [page("/about", "landing")],
      [section("journal", ["/journal/**"])],
      [
        pageTypeRecord("article", "Article"),
        pageTypeRecord("landing", "Landing"),
      ],
    );

    expect(groups.map((group) => group.key)).toEqual(["landing"]);
  });

  test("a removed section is ignored and its pages fall through", () => {
    const groups = groupPages(
      [page("/journal/one")],
      [section("journal", ["/journal/**"], { removedAt: new Date() })],
      [pageTypeRecord("article", "Article")],
    );

    expect(groups).toEqual([
      {
        kind: "pageType",
        key: "article",
        label: "Article",
        pages: [page("/journal/one")],
      },
    ]);
  });

  test("a page type the site no longer declares still gets a heading", () => {
    const groups = groupPages(
      [page("/orphan", "legacy-guide")],
      [],
      [pageTypeRecord("article", "Article")],
    );

    expect(groups).toEqual([
      {
        kind: "pageType",
        key: "legacy-guide",
        label: "Legacy guide",
        pages: [page("/orphan", "legacy-guide")],
      },
    ]);
  });

  test("a label falls back to the humanised name", () => {
    const groups = groupPages(
      [page("/journal/one"), page("/about", "landing")],
      [section("journal", ["/journal/**"])],
      [pageTypeRecord("landing")],
    );

    expect(groups.map((group) => group.label)).toEqual(["Journal", "Landing"]);
  });

  test("pages stay sorted by URL inside a group", () => {
    const groups = groupPages(
      [page("/journal/two"), page("/journal/one"), page("/journal/three")],
      [],
      [pageTypeRecord("article")],
    );

    expect(groups[0].pages.map((entry) => entry.url)).toEqual([
      "/journal/one",
      "/journal/three",
      "/journal/two",
    ]);
  });
});

describe("listSections", () => {
  const insertSection = async (row: {
    name: string;
    label?: string | null;
    paths: string[];
    position: number;
    removed?: boolean;
  }): Promise<void> => {
    await db`
      INSERT INTO cms_page_sections (name, label, paths, position, removed_at)
      VALUES (
        ${row.name},
        ${row.label ?? null},
        ${jsonbValue(row.paths)},
        ${row.position},
        ${row.removed ? new Date() : null}
      )
    `;
  };

  beforeEach(async () => {
    await cleanupTestData(db);
  });

  test("starts empty", async () => {
    expect(await listSections()).toEqual([]);
  });

  test("returns sections in position order with their paths parsed", async () => {
    await insertSection({
      name: "journal",
      label: "Journal",
      paths: ["/journal", "/journal/**"],
      position: 1,
    });
    await insertSection({
      name: "case-studies",
      paths: ["/case-study-*"],
      position: 0,
    });

    const sections = await listSections();

    expect(
      sections.map((entry) => [entry.name, entry.label, entry.position]),
    ).toEqual([
      ["case-studies", null, 0],
      ["journal", "Journal", 1],
    ]);
    expect(sections.map((entry) => entry.paths)).toEqual([
      ["/case-study-*"],
      ["/journal", "/journal/**"],
    ]);
    expect(sections.every((entry) => entry.removedAt === null)).toBe(true);
  });

  test("keeps removed rows for the caller to ignore", async () => {
    await insertSection({
      name: "journal",
      paths: ["/journal/**"],
      position: 0,
      removed: true,
    });

    const [entry] = await listSections();

    expect(entry.name).toBe("journal");
    expect(entry.removedAt).toBeInstanceOf(Date);
  });
});

afterAll(async () => {
  await connection.end();
  mock.restore();
});
