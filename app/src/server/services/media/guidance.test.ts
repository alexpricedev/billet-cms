import { describe, expect, test } from "bun:test";
import {
  type BlockFields,
  block,
  group,
  image,
  list,
  text,
} from "@alexpricedev/billet-cms/fields";
import {
  DELETED_IMAGE_MESSAGE,
  findDeletedImageIssues,
  findImageGuidanceIssues,
  referencedMediaIds,
} from "./guidance";

/** The published metadata for a set of fields, the way a block type stores it. */
const metadataOf = (fields: BlockFields) =>
  Object.entries(fields).map(([name, field]) => field.metadata(name));

const id = (n: number): string =>
  `${`${n}`.repeat(8)}-0000-0000-0000-000000000000`;

const narrow = { width: 100, height: 100 };

describe("collecting image references", () => {
  // The regression this file was written for: the walker recursed into a list
  // item with the item wrapped in a record keyed by the item metadata's own
  // name, so it looked for `item.item`, found nothing, and reported no
  // references at all for an image inside a list.
  test("finds an image inside a list", () => {
    const fields = { images: list(image({ minWidth: 400 })) };

    expect(
      referencedMediaIds(metadataOf(fields), {
        images: [{ mediaId: id(1) }, { mediaId: id(2) }],
      }),
    ).toEqual([id(1), id(2)]);
  });

  test("finds an image inside a group", () => {
    const fields = { cta: group({ label: text(), photo: image() }) };

    expect(
      referencedMediaIds(metadataOf(fields), {
        cta: { label: "Go", photo: { mediaId: id(3) } },
      }),
    ).toEqual([id(3)]);
  });

  test("finds an image inside a group inside a list", () => {
    const fields = {
      cards: list(group({ title: text(), photo: image() })),
    };

    expect(
      referencedMediaIds(metadataOf(fields), {
        cards: [
          { title: "One", photo: { mediaId: id(4) } },
          { title: "Two", photo: { mediaId: id(5) } },
        ],
      }),
    ).toEqual([id(4), id(5)]);
  });

  test("still finds one at the top level", () => {
    const fields = { hero: image() };

    expect(
      referencedMediaIds(metadataOf(fields), { hero: { mediaId: id(6) } }),
    ).toEqual([id(6)]);
  });

  test("ignores a value whose shape doesn't match its field", () => {
    const fields = { images: list(image()), cta: group({ photo: image() }) };

    expect(
      referencedMediaIds(metadataOf(fields), {
        images: "not an array",
        cta: "not an object",
      }),
    ).toEqual([]);
  });
});

describe("findImageGuidanceIssues", () => {
  // Before the walker was fixed this returned nothing, so a save could put a
  // 100px image in a field that asked for 400.
  test("enforces minWidth on an image inside a list", () => {
    const fields = { images: list(image({ minWidth: 400 })) };
    const sizes = new Map([[id(1), narrow]]);

    const issues = findImageGuidanceIssues(
      metadataOf(fields),
      { images: [{ mediaId: id(1) }] },
      sizes,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("images.0.mediaId");
    expect(issues[0]?.message).toContain("at least 400px");
  });

  test("enforces minWidth on an image inside a group", () => {
    const fields = { cta: group({ photo: image({ minWidth: 400 }) }) };
    const sizes = new Map([[id(1), narrow]]);

    const issues = findImageGuidanceIssues(
      metadataOf(fields),
      { cta: { photo: { mediaId: id(1) } } },
      sizes,
    );

    expect(issues.map((issue) => issue.path)).toEqual(["cta.photo.mediaId"]);
  });

  test("names the row an issue is in", () => {
    const fields = { cards: list(group({ photo: image({ minWidth: 400 }) })) };
    const sizes = new Map([
      [id(1), { width: 800, height: 800 }],
      [id(2), narrow],
    ]);

    const issues = findImageGuidanceIssues(
      metadataOf(fields),
      { cards: [{ photo: { mediaId: id(1) } }, { photo: { mediaId: id(2) } }] },
      sizes,
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      "cards.1.photo.mediaId",
    ]);
  });
});

describe("findDeletedImageIssues", () => {
  // The hole this closes: an image deleted while only a draft referenced it,
  // then that draft published — a live page pointing at a file that is gone.
  test("refuses a publish naming a deleted image inside a list", () => {
    const fields = { images: list(image()) };

    const issues = findDeletedImageIssues(
      metadataOf(fields),
      { images: [{ mediaId: id(1) }] },
      new Set<string>(),
    );

    expect(issues).toEqual([
      { path: "images.0.mediaId", message: DELETED_IMAGE_MESSAGE },
    ]);
  });

  test("allows one whose row is still there", () => {
    const fields = { images: list(image()) };

    expect(
      findDeletedImageIssues(
        metadataOf(fields),
        { images: [{ mediaId: id(1) }] },
        new Set([id(1)]),
      ),
    ).toEqual([]);
  });
});

describe("blocks are the same shape as loose fields", () => {
  test("a block's own fields walk identically", () => {
    const card = block("card", { photo: image({ minWidth: 400 }) });

    expect(
      referencedMediaIds(metadataOf(card.fields), {
        photo: { mediaId: id(7) },
      }),
    ).toEqual([id(7)]);
  });
});
