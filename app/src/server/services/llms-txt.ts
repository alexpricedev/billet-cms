import { absolute, SITE_DESCRIPTION, SITE_NAME } from "./seo";

// Builds the /llms.txt body — the emerging convention that gives LLMs and AI
// agents a short, curated markdown index of the site. Unlike the sitemap (an
// exhaustive machine list of URLs), this is a hand-written summary with a
// one-line description per page. It controls nothing; it is purely a hint.
//
// The page list is kept in sync with the public routes by a drift test in
// llms-txt.test.ts, so a new public page can't silently go unlisted.

interface LlmsPage {
  path: string;
  title: string;
  description: string;
}

const PAGES: LlmsPage[] = [
  {
    path: "/forms",
    title: "Forms",
    description:
      "Server-rendered form handling with validation, CSRF protection, and progressive enhancement.",
  },
];

const RESOURCES: LlmsPage[] = [
  {
    path: "/sitemap.xml",
    title: "Sitemap",
    description: "XML sitemap of every public page.",
  },
  {
    path: "/.well-known/security.txt",
    title: "Security policy",
    description: "How to report a security vulnerability (RFC 9116).",
  },
];

const linkLine = ({ path, title, description }: LlmsPage): string =>
  `- [${title}](${absolute(path)}): ${description}`;

export const buildLlmsTxt = (): string =>
  [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "Billet CMS is the headless CMS service for a Billet site: it runs on its own host, shares the site's PostgreSQL database, and builds its forms from the block, slot and page definitions the site publishes. Sign-in goes through the site — the CMS has no login of its own.",
    "",
    "## Pages",
    "",
    ...PAGES.map(linkLine),
    "",
    "## Resources",
    "",
    ...RESOURCES.map(linkLine),
    "",
  ].join("\n");
