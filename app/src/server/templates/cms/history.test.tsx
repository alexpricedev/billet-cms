import { describe, expect, test } from "bun:test";
import type { FieldMetadata } from "@alexpricedev/billet-cms/contract";
import { renderToString } from "preact-render-to-string";
import type {
  BlockTypeRecord,
  PageRecord,
  SlotRecord,
} from "../../services/content";
import {
  buildExcerpt,
  EXCERPT_LENGTH,
  firstTextField,
  pageExcerpt,
} from "../../services/content/history-excerpt";
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
    excerpt: "Our work · Three recent projects, from a ferry timetable",
  },
  {
    id: "r1",
    createdAt: new Date("2026-01-11T09:00:00Z"),
    authorEmail: "sam@example.com",
    isPublished: false,
    isLatest: false,
    isDraft: false,
    restoredFromAt: null,
    excerpt: "Our work · A first pass at the work page.",
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

  test("dates the Restore button to the minute and names the author", () => {
    // The button's own text, not just the aria-label, carries the time.
    expect(html).toContain(">Restore the 11 Jan 09:00 version</button>");
    expect(html).toContain(
      'aria-label="Restore the 11 Jan version, saved 11 Jan 2026, 09:00 UTC by sam@example.com as draft"',
    );
  });

  test("shows each row's time and a one-line excerpt", () => {
    expect(html).toContain("25 Oct 2026, 08:50 UTC");
    expect(html).toContain("11 Jan 2026, 09:00 UTC");
    expect(html).toContain(
      "Our work · Three recent projects, from a ferry timetable",
    );
    expect(html).toContain("Our work · A first pass at the work page.");
  });

  test("tells two same-day revisions apart by their Restore labels", () => {
    const sameDay = [
      {
        ...revisions[0],
        id: "r3",
        createdAt: new Date("2026-01-11T14:32:00Z"),
      },
      {
        ...revisions[1],
        id: "r2",
        createdAt: new Date("2026-01-11T12:00:00Z"),
      },
      revisions[1],
    ];
    const rendered =
      _name === "slot"
        ? renderToString(
            <SlotHistory
              user={user}
              slot={slot}
              blockType={hero}
              revisions={sameDay}
              restoreCsrfToken="t"
            />,
          )
        : renderToString(
            <PageHistory
              user={user}
              page={page}
              revisions={sameDay}
              restoreCsrfToken="t"
            />,
          );

    expect(rendered).toContain("Restore the 11 Jan 12:00 version");
    expect(rendered).toContain("Restore the 11 Jan 09:00 version");
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
      "<code>footer.cta</code> · block <code>cta</code>",
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
    expect(pageHtml).toContain(
      '<p class="cms-slot-meta"><code>/about</code></p>',
    );
    expect(pageHtml).not.toContain("Page <code>");
  });
});

describe("history excerpts", () => {
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Three recent" },
          { type: "text", text: "projects." },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "A second line." }],
      },
    ],
  };

  const fields: FieldMetadata[] = [
    { name: "photo", kind: "image", required: false },
    { name: "heading", kind: "text", required: true },
    { name: "body", kind: "richText", required: false },
  ];

  test("reads the first text field in field order, not the first string", () => {
    expect(
      firstTextField(fields, {
        photo: { mediaId: "4b8d8a2e-0000-4000-8000-000000000000" },
        heading: "  Selected   work ",
        body: document,
      }),
    ).toBe("Selected work");

    // The image's id is a string, but it is not the block's copy.
    expect(firstTextField(fields, { photo: "not-the-excerpt" })).toBeNull();
  });

  test("skips a blank text field and flattens a rich text document", () => {
    const ordered: FieldMetadata[] = [
      { name: "lead", kind: "text", required: false },
      { name: "body", kind: "richText", required: true },
    ];
    expect(firstTextField(ordered, { lead: "   ", body: document })).toBe(
      "Three recent projects. A second line.",
    );
  });

  test("looks inside a group", () => {
    const grouped: FieldMetadata[] = [
      {
        name: "banner",
        kind: "group",
        required: false,
        fields: [{ name: "title", kind: "text", required: true }],
      },
    ];
    expect(firstTextField(grouped, { banner: { title: "Nested copy" } })).toBe(
      "Nested copy",
    );
  });

  test("joins the parts and cuts a long excerpt to the limit", () => {
    expect(buildExcerpt(["Our work", "Selected work"])).toBe(
      "Our work · Selected work",
    );
    expect(buildExcerpt(["Our work", null, "  "])).toBe("Our work");

    const long = buildExcerpt(["x".repeat(200)]);
    expect(long).toHaveLength(EXCERPT_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(long.slice(0, -1)).toBe("x".repeat(EXCERPT_LENGTH - 1));
  });

  test("drops a block text that only repeats the page title", () => {
    expect(pageExcerpt("Our work", "Our work")).toBe("Our work");
    expect(pageExcerpt("Our work", "Selected work")).toBe(
      "Our work · Selected work",
    );
    expect(pageExcerpt("Our work", null)).toBe("Our work");
  });
});
