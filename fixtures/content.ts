/**
 * Northwind Studio's content, as plain data with fixed ids and timestamps.
 *
 * `ux/personas.md` is the source of truth for what is here. Every row is written
 * by SQL (`load.ts`), because the CMS's own services mint ids and use `now()`.
 */
import { imageId } from "./images.ts";
import { PERSONAS } from "./personas.ts";

const persona = (key: string): string => {
  const found = PERSONAS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Unknown persona "${key}"`);
  return found.id;
};

export const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  })),
});

/** 200 UTF-16 code units (the limit the CMS enforces), emoji included. */
export const LONG_TITLE = (() => {
  const prefix = "🌊🚢 Northwind field notes: ";
  const filler =
    "what we learned shipping websites for harbours, boats and the people who love them ";
  let title = prefix;
  while (title.length < 198) title += filler;
  return `${title.slice(0, 198)}🌅`;
})();

export const SLOT_IDS = {
  "home.hero": "60000000-0000-4000-8000-000000000001",
  "footer.cta": "60000000-0000-4000-8000-000000000002",
} as const;

export const PAGE_IDS = {
  about: "30000000-0000-4000-8000-000000000001",
  work: "30000000-0000-4000-8000-000000000002",
  draftIdeas: "30000000-0000-4000-8000-000000000003",
  longTitle: "30000000-0000-4000-8000-000000000004",
} as const;

const revisionId = (n: number): string =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface FixtureRevision {
  id: string;
  targetType: "page" | "slot";
  targetId: string;
  content: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

const photo = (key: string) => ({ mediaId: imageId(key) });

export const REVISIONS: readonly FixtureRevision[] = [
  // home.hero: published R1, then a newer draft R2.
  {
    id: revisionId(1),
    targetType: "slot",
    targetId: SLOT_IDS["home.hero"],
    content: { heading: "We make websites that last", photo: photo("harbour") },
    createdBy: persona("priya"),
    createdAt: "2026-01-10T09:00:00.000Z",
  },
  {
    id: revisionId(2),
    targetType: "slot",
    targetId: SLOT_IDS["home.hero"],
    content: {
      heading: "Websites that outlast the trend",
      photo: photo("harbour"),
    },
    createdBy: persona("leo"),
    createdAt: "2026-01-12T16:30:00.000Z",
  },
  // footer.cta: published.
  {
    id: revisionId(3),
    targetType: "slot",
    targetId: SLOT_IDS["footer.cta"],
    content: {
      heading: "Have a project in mind?",
      link: {
        type: "url",
        url: "mailto:hello@example.com",
        label: "Say hello",
      },
    },
    createdBy: persona("priya"),
    createdAt: "2026-01-10T09:10:00.000Z",
  },
  // /about: published.
  {
    id: revisionId(4),
    targetType: "page",
    targetId: PAGE_IDS.about,
    content: {
      blocks: [
        { type: "hero", heading: "About Northwind", photo: photo("team") },
        {
          type: "text",
          body: doc(
            "Northwind Studio is four people who build small, fast websites.",
            "We work with harbours, makers and anyone who wants a site that stays up.",
          ),
        },
        { type: "gallery", images: [photo("team")] },
        {
          type: "quote",
          text: "They shipped on time and the site has never gone down.",
          attribution: "A happy harbourmaster",
        },
        {
          type: "cta",
          heading: "Want to work together?",
          link: { type: "page", pageId: PAGE_IDS.work, label: "See our work" },
        },
      ],
    },
    createdBy: persona("priya"),
    createdAt: "2026-01-11T11:00:00.000Z",
  },
  // /work: three revisions; the second is published, the third is a draft.
  {
    id: revisionId(5),
    targetType: "page",
    targetId: PAGE_IDS.work,
    content: {
      blocks: [
        { type: "hero", heading: "Our work", photo: photo("project") },
        { type: "text", body: doc("A first pass at the work page.") },
      ],
    },
    createdBy: persona("priya"),
    createdAt: "2026-01-11T12:00:00.000Z",
  },
  {
    id: revisionId(6),
    targetType: "page",
    targetId: PAGE_IDS.work,
    content: {
      blocks: [
        { type: "hero", heading: "Selected work", photo: photo("project") },
        {
          type: "text",
          body: doc(
            "Three recent projects, from a ferry timetable to a boatyard shop.",
          ),
        },
        { type: "gallery", images: [photo("project"), photo("team")] },
      ],
    },
    createdBy: persona("leo"),
    createdAt: "2026-01-13T10:00:00.000Z",
  },
  {
    id: revisionId(7),
    targetType: "page",
    targetId: PAGE_IDS.work,
    content: {
      blocks: [
        { type: "hero", heading: "Selected work", photo: photo("project") },
        {
          type: "text",
          body: doc("Oops: this draft deleted the project list by mistake."),
        },
      ],
    },
    createdBy: persona("leo"),
    createdAt: "2026-01-14T08:45:00.000Z",
  },
  // /draft-ideas: never published.
  {
    id: revisionId(8),
    targetType: "page",
    targetId: PAGE_IDS.draftIdeas,
    content: {
      blocks: [
        {
          type: "text",
          body: doc("Notes toward a new homepage. Not ready to show anyone."),
        },
        { type: "gallery", images: [photo("sketch")] },
      ],
    },
    createdBy: persona("zofia"),
    createdAt: "2026-01-12T08:30:00.000Z",
  },
  // The 200-character, emoji title page: published.
  {
    id: revisionId(9),
    targetType: "page",
    targetId: PAGE_IDS.longTitle,
    content: {
      blocks: [
        {
          type: "text",
          body: doc("A page whose title is as long as the editor allows."),
        },
      ],
    },
    createdBy: persona("zofia"),
    createdAt: "2026-01-12T09:00:00.000Z",
  },
];

export interface FixturePage {
  id: string;
  pageType: string;
  url: string;
  title: string;
  seoDescription: string | null;
  publishedRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PAGES: readonly FixturePage[] = [
  {
    id: PAGE_IDS.about,
    pageType: "landing",
    url: "/about",
    title: "About Northwind",
    seoDescription: "Four people who build small, fast websites.",
    publishedRevisionId: revisionId(4),
    createdAt: "2026-01-11T10:00:00.000Z",
    updatedAt: "2026-01-11T11:00:00.000Z",
  },
  {
    id: PAGE_IDS.work,
    pageType: "landing",
    url: "/work",
    title: "Our work",
    seoDescription: null,
    publishedRevisionId: revisionId(6),
    createdAt: "2026-01-11T11:30:00.000Z",
    updatedAt: "2026-01-13T10:00:00.000Z",
  },
  {
    id: PAGE_IDS.draftIdeas,
    pageType: "article",
    url: "/draft-ideas",
    title: "Draft ideas",
    seoDescription: null,
    publishedRevisionId: null,
    createdAt: "2026-01-12T08:00:00.000Z",
    updatedAt: "2026-01-12T08:30:00.000Z",
  },
  {
    id: PAGE_IDS.longTitle,
    pageType: "article",
    url: "/long-title",
    title: LONG_TITLE,
    seoDescription: null,
    publishedRevisionId: revisionId(9),
    createdAt: "2026-01-12T08:50:00.000Z",
    updatedAt: "2026-01-12T09:00:00.000Z",
  },
];

/** `/studio` was this page's first URL; it now redirects to `/about`. */
export const REDIRECTS = [
  {
    id: "40000000-0000-4000-8000-000000000001",
    fromPath: "/studio",
    toPageId: PAGE_IDS.about,
    createdAt: "2026-01-11T11:30:00.000Z",
  },
] as const;

export const SLOT_PUBLISHED = {
  "home.hero": revisionId(1),
  "footer.cta": revisionId(3),
} as const;

export const EXPORT_TOKENS = [
  {
    id: "50000000-0000-4000-8000-000000000001",
    label: "Preview environment",
    createdBy: persona("ade"),
    createdAt: "2026-01-09T12:00:00.000Z",
    lastUsedAt: "2026-01-15T07:00:00.000Z",
    revokedAt: null,
    live: true,
  },
  {
    id: "50000000-0000-4000-8000-000000000002",
    label: "Old laptop",
    createdBy: persona("ade"),
    createdAt: "2026-01-02T12:00:00.000Z",
    lastUsedAt: "2026-01-05T09:00:00.000Z",
    revokedAt: "2026-01-08T17:00:00.000Z",
    live: false,
  },
] as const;

/** Every definition row's fixed `created_at`/`updated_at`. */
export const DEFINITIONS_AT = "2026-01-05T09:00:00.000Z";
export const CONTENT_VERSION = 42;
