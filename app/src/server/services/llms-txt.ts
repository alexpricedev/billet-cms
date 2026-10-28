import { absolute, SITE_DESCRIPTION, SITE_NAME } from "./seo";

// Builds the /llms.txt body — the emerging convention that gives LLMs and AI
// agents a short, curated markdown index of the site. Unlike the sitemap (an
// exhaustive machine list of URLs), this is a hand-written summary with a
// one-line description per page. It controls nothing; it is purely a hint.
//
// The page list is kept in sync with the public routes by a drift test in
// llms-txt.test.ts, so a new public page can't silently go unlisted. The CMS
// itself has no public pages, so PAGES is empty and the Pages section is
// omitted from the body rather than shipped as a heading with nothing under it.

interface LlmsPage {
  path: string;
  title: string;
  description: string;
}

const PAGES: LlmsPage[] = [];

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
    `${SITE_NAME} is the headless CMS service for this site: it runs on its own host, shares the site's PostgreSQL database, and builds its forms from the block, slot and page definitions the site publishes. Sign-in goes through the site — the CMS has no login of its own.`,
    "",
    ...(PAGES.length > 0 ? ["## Pages", "", ...PAGES.map(linkLine), ""] : []),
    "## Resources",
    "",
    ...RESOURCES.map(linkLine),
    "",
  ].join("\n");
