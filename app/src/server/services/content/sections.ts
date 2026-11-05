/**
 * Reading the sections a site declared, and grouping pages under them.
 *
 * A section is a heading the Pages list groups pages under, chosen by the URL
 * patterns the site publishes. A page belongs to the first section whose
 * patterns match its URL; a page that matches none falls back to its page
 * type's heading. `groupPages` is pure — the controller reads the three rows
 * and hands them over — so the rules are tested without a database.
 */
import { humanise } from "../../utils/humanise";
import { db } from "../database";
import type { PageTypeRecord } from "./definitions";
import type { PageRecord } from "./pages";

export interface SectionRecord {
  id: string;
  name: string;
  /** The heading's words; `null` falls back to the humanised name. */
  label: string | null;
  /** The site paths this section covers, e.g. `/journal/**`. */
  paths: string[];
  /** The site config's order, which is the order the Pages list shows. */
  position: number;
  removedAt: Date | null;
}

interface SectionRow {
  id: string;
  name: string;
  label: string | null;
  paths: string[];
  position: number;
  removed_at: Date | null;
}

const toSection = (row: SectionRow): SectionRecord => ({
  id: row.id,
  name: row.name,
  label: row.label,
  paths: row.paths,
  position: row.position,
  removedAt: row.removed_at,
});

/**
 * Every section in a site's config order, live and removed.
 *
 * Removed rows are kept so a redeploy that declares the section again can
 * restore it; `groupPages` ignores them, the way the Pages list does.
 */
export const listSections = async (): Promise<SectionRecord[]> => {
  const rows = (await db`
    SELECT id, name, label, paths, position, removed_at
    FROM cms_page_sections
    ORDER BY position, name
  `) as SectionRow[];
  return rows.map(toSection);
};

/** One regex metacharacter, escaped so it matches itself. */
const escapeRegExp = (char: string): string =>
  /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

/**
 * Whether a section's path pattern matches a page's URL.
 *
 * The pattern is anchored at both ends: `*` matches within one segment
 * (`[^/]*`), `**` crosses any number of segments (`.*`), and every other
 * character is literal. So `/case-study-*` covers `/case-study-harbour` but not
 * `/case-study/harbour`, while `/journal/**` covers everything under
 * `/journal` — although, with the slash it demands, not `/journal` itself.
 */
export const matchesPattern = (pattern: string, url: string): boolean => {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`).test(url);
};

export interface PageGroup {
  kind: "section" | "pageType";
  /** The section's or page type's name. */
  key: string;
  /** The heading: the declared label, else the humanised name. */
  label: string;
  /** The pages under the heading, sorted by URL. */
  pages: PageRecord[];
}

/**
 * Group pages under their sections, then under their page types.
 *
 * Sections come first in config order (their published `position`), each with
 * the pages matching one of its patterns. Every page no live section took falls
 * back to a group named for its page type, and those groups follow in page-type
 * name order — including a type the site no longer declares, so a page is never
 * lost from the list. Groups with no pages are dropped, and pages inside a group
 * stay in URL order.
 */
export const groupPages = (
  pages: PageRecord[],
  sections: SectionRecord[],
  pageTypes: PageTypeRecord[],
): PageGroup[] => {
  const liveSections = sections
    .filter((section) => section.removedAt === null)
    .sort((a, b) => a.position - b.position);

  const sectionGroups = liveSections.map((section) => ({
    kind: "section" as const,
    key: section.name,
    label: section.label ?? humanise(section.name),
    pages: [] as PageRecord[],
  }));

  const byPageType = new Map<string, PageRecord[]>();
  for (const page of pages) {
    const index = liveSections.findIndex((section) =>
      section.paths.some((pattern) => matchesPattern(pattern, page.url)),
    );
    if (index === -1) {
      const existing = byPageType.get(page.pageType);
      if (existing) existing.push(page);
      else byPageType.set(page.pageType, [page]);
    } else {
      sectionGroups[index].pages.push(page);
    }
  }

  const labels = new Map(pageTypes.map((type) => [type.name, type.label]));
  const pageTypeGroups = [...byPageType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, typePages]) => ({
      kind: "pageType" as const,
      key: name,
      label: labels.get(name) ?? humanise(name),
      pages: typePages,
    }));

  return [...sectionGroups, ...pageTypeGroups]
    .filter((group) => group.pages.length > 0)
    .map((group) => ({
      ...group,
      pages: [...group.pages].sort((a, b) => a.url.localeCompare(b.url)),
    }));
};
