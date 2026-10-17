import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import { block, image, pageType, text } from "@alexpricedev/billet-cms/fields";
import {
  createCmsMedia,
  renderCmsImage,
} from "@alexpricedev/billet-cms/server";
import sharp from "sharp";
import {
  seedBlockType,
  seedPageType,
  seedSlot,
} from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";
import {
  animatedWebpBytes,
  apngBytes,
  fakePngHeader,
  gifBytes,
  hasGpsCoordinates,
  makeJpeg,
  svgBytes,
  withExif,
  withFullMetadata,
} from "../../test-utils/images";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import {
  createPage,
  publishPage,
  publishSlot,
  savePageDraft,
  saveSlotDraft,
} from "../content";
import { db } from "../database";
import {
  createMedia,
  deleteMedia,
  getMediaById,
  getMediaOptionsByIds,
  getMediaUsage,
  listMedia,
  listMediaOptions,
  listPickerMedia,
  MAX_ALT_LENGTH,
  MEDIA_PICKER_LIMIT,
  updateMediaAlt,
  updateMediaFocalPoint,
} from "./media";
import { createMemoryMediaStorage } from "./storage";

const photoBlock = block(
  "hero",
  { heading: text({ max: 80 }), photo: image() },
  () => null,
);

const guidedBlock = block(
  "banner",
  { heading: text(), photo: image({ minWidth: 1600 }) },
  () => null,
);

const squareBlock = block(
  "square",
  { photo: image({ aspect: "1:1" }) },
  () => null,
);

const widthOf = (variants: MediaVariant[]): number[] =>
  variants.map((variant) => variant.width);

describe("createMedia", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  test("stores the row, every rendition, and the centre focal point", async () => {
    const storage = createMemoryMediaStorage();
    const result = await createMedia({
      bytes: await makeJpeg(3000, 1500),
      alt: "A red field",
      actorId: null,
      storage,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { media } = result;
    expect(media.alt).toBe("A red field");
    expect(media.contentType).toBe("image/jpeg");
    expect(media.width).toBe(3000);
    expect(media.height).toBe(1500);
    expect(media.focalX).toBe(0.5);
    expect(media.focalY).toBe(0.5);
    expect(media.byteSize).toBeGreaterThan(0);
    expect(widthOf(media.variants)).toEqual([480, 960, 1600, 2400, 3000]);

    // The original plus a WebP and a fallback for each of the five widths.
    expect(storage.objects.size).toBe(1 + 5 * 2);
    for (const variant of media.variants) {
      expect(storage.objects.has(variant.webpKey)).toBe(true);
      expect(storage.objects.has(variant.fallbackKey)).toBe(true);
      expect(variant.webpUrl.startsWith("https://media.test/")).toBe(true);
    }
    expect(await listMedia()).toHaveLength(1);
  });

  test("stores the bytes with GPS EXIF stripped", async () => {
    const storage = createMemoryMediaStorage();
    const result = await createMedia({
      bytes: withExif(await makeJpeg(1200, 800)),
      alt: "Taken on holiday",
      actorId: null,
      storage,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = storage.objects.get(result.media.objectKey);
    expect(original).toBeDefined();
    const metadata = await sharp(original?.body ?? new Uint8Array()).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  // The Done-when path: a JPEG that carries GPS EXIF, XMP and an ICC profile is
  // stored without them, at every width.
  test("strips EXIF (GPS included), XMP and ICC from the original and every rendition", async () => {
    const storage = createMemoryMediaStorage();
    const fixture = await withFullMetadata(await makeJpeg(1200, 800));

    const before = await sharp(fixture).metadata();
    expect(before.exif).toBeDefined();
    expect(before.icc).toBeDefined();
    expect(before.xmp).toBeDefined();
    expect(hasGpsCoordinates(before.exif)).toBe(true);

    const result = await createMedia({
      bytes: fixture,
      alt: "Taken at home",
      actorId: null,
      storage,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = [
      result.media.objectKey,
      ...result.media.variants.flatMap((variant) => [
        variant.webpKey,
        variant.fallbackKey,
      ]),
    ];
    for (const key of keys) {
      const metadata = await sharp(
        storage.objects.get(key)?.body ?? new Uint8Array(),
      ).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
  });

  test("stores variants as a jsonb array, not a jsonb string", async () => {
    const result = await createMedia({
      bytes: await makeJpeg(1200, 800),
      alt: "A field",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(true);

    const rows = (await db`
      SELECT jsonb_typeof(variants) AS kind FROM cms_media
    `) as { kind: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("array");
  });

  test("turns a storage or insert failure into a form issue, not a throw", async () => {
    const failing = {
      ...createMemoryMediaStorage(),
      put: async () => {
        throw new Error("bucket is down");
      },
    };

    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Nope",
      actorId: null,
      storage: failing,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/couldn't save that image/);
    expect(await listMedia()).toHaveLength(0);
  });

  // The puts run together, so one failing mid-batch must still clean up every
  // object the upload could have written — including the one whose put rejected,
  // which may have landed before it failed.
  test("deletes every planned object when one put fails mid-batch", async () => {
    const memory = createMemoryMediaStorage();
    const attempted: string[] = [];
    const landed: string[] = [];
    const deleted: string[] = [];
    let calls = 0;
    const storage = {
      ...memory,
      put: async (key: string, body: Uint8Array, contentType: string) => {
        calls += 1;
        attempted.push(key);
        if (calls === 3) throw new Error("bucket hiccup");
        memory.objects.set(key, { body: body.slice(), contentType });
        landed.push(key);
      },
      delete: async (key: string) => {
        deleted.push(key);
        memory.objects.delete(key);
      },
    };

    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Half written",
      actorId: null,
      storage,
    });

    expect(result.ok).toBe(false);
    // Several objects landed before the failing put, so an empty store below
    // really proves the cleanup ran rather than that nothing was written.
    expect(landed.length).toBeGreaterThanOrEqual(2);
    expect(memory.objects.size).toBe(0);
    // Every key the upload planned was attempted and then deleted, not just the
    // four puts that reported success.
    expect(attempted.length).toBe(5);
    expect([...deleted].sort()).toEqual([...attempted].sort());
    expect(await listMedia()).toHaveLength(0);
  });

  // The row write can fail after every object has landed. The cleanup is driven
  // by the plan rather than the puts' outcomes, so the whole set still goes and
  // the editor gets a retryable form issue.
  test("deletes every stored object when the row insert fails after the puts", async () => {
    const memory = createMemoryMediaStorage();
    const landed: string[] = [];
    const deleted: string[] = [];
    const storage = {
      ...memory,
      put: async (key: string, body: Uint8Array, contentType: string) => {
        await memory.put(key, body, contentType);
        landed.push(key);
      },
      delete: async (key: string) => {
        deleted.push(key);
        memory.objects.delete(key);
      },
    };

    // A trigger that refuses the row stands in for any constraint, connection
    // or column failure after the bucket writes have succeeded.
    await db`CREATE OR REPLACE FUNCTION cms_media_refuse_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'insert refused for the test'; END;
    $$ LANGUAGE plpgsql`;
    await db`CREATE TRIGGER cms_media_refuse_insert BEFORE INSERT ON cms_media
      FOR EACH ROW EXECUTE FUNCTION cms_media_refuse_insert()`;
    try {
      const result = await createMedia({
        bytes: await makeJpeg(800, 400),
        alt: "All written, no row",
        actorId: null,
        storage,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.message).toMatch(/couldn't save that image/);
    } finally {
      await db`DROP TRIGGER IF EXISTS cms_media_refuse_insert ON cms_media`;
      await db`DROP FUNCTION IF EXISTS cms_media_refuse_insert()`;
    }

    // Every object was stored, and every one was deleted again.
    expect(landed.length).toBe(5);
    expect(memory.objects.size).toBe(0);
    expect([...deleted].sort()).toEqual([...landed].sort());
    expect(await listMedia()).toHaveLength(0);
  });

  test("listMedia returns the whole library newest first, and a limit takes the newest", async () => {
    const storage = createMemoryMediaStorage();
    for (const alt of ["First", "Second", "Third"]) {
      const result = await createMedia({
        bytes: await makeJpeg(800, 400),
        alt,
        actorId: null,
        storage,
      });
      expect(result.ok).toBe(true);
    }

    const all = await listMedia();
    expect(all).toHaveLength(3);
    // Newest first, named: the third upload is the newest and comes back first.
    expect(all.map((row) => row.alt)).toEqual(["Third", "Second", "First"]);

    const limited = await listMedia({ limit: 2 });
    expect(limited).toHaveLength(2);
    // A limit takes the head of the same newest-first list, not a different set.
    expect(limited.map((row) => row.id)).toEqual(
      all.slice(0, 2).map((row) => row.id),
    );
    expect(limited.map((row) => row.alt)).toEqual(["Third", "Second"]);
  });

  // The picker only needs these four fields; the old shape read the whole row
  // (and its thumbnail URL) to build them, so a large library is now walked for
  // neither.
  test("listMediaOptions selects only the picker's fields", async () => {
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "A field",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!result.ok) throw new Error("upload failed");

    const options = await listMediaOptions();
    expect(options).toHaveLength(1);
    expect(Object.keys(options[0]).sort()).toEqual([
      "alt",
      "height",
      "id",
      "width",
    ]);
    expect(options[0].alt).toBe("A field");
  });

  // The picker lists the newest uploads capped at the limit, tells the caller
  // whether the library was really bigger, and adds any image the content
  // references so its label survives outside the cap.
  test("listPickerMedia caps the list and carries referenced rows", async () => {
    const storage = createMemoryMediaStorage();
    for (let index = 0; index < MEDIA_PICKER_LIMIT; index += 1) {
      const result = await createMedia({
        bytes: await makeJpeg(40, 40),
        alt: `Upload ${index}`,
        actorId: null,
        storage,
      });
      if (!result.ok) throw new Error("upload failed");
    }

    const atCap = await listPickerMedia({});
    expect(atCap.media).toHaveLength(MEDIA_PICKER_LIMIT);
    expect(atCap.capped).toBe(false);

    // One more upload and the library is genuinely bigger than the cap.
    const extra = await createMedia({
      bytes: await makeJpeg(40, 40),
      alt: "Newest",
      actorId: null,
      storage,
    });
    if (!extra.ok) throw new Error("upload failed");

    const overCap = await listPickerMedia({});
    expect(overCap.media).toHaveLength(MEDIA_PICKER_LIMIT);
    expect(overCap.capped).toBe(true);
    // The oldest upload fell out of the cap and is not referenced, so it is gone.
    expect(overCap.media.some((option) => option.alt === "Upload 0")).toBe(
      false,
    );

    // A reference to an upload outside the newest cap brings its row back, so
    // its label survives outside the cap.
    const oldest = atCap.media.find((option) => option.alt === "Upload 0");
    const referenced = await listPickerMedia({
      photo: { mediaId: oldest?.id },
    });
    expect(referenced.media).toHaveLength(MEDIA_PICKER_LIMIT + 1);
    expect(referenced.media.some((option) => option.alt === "Upload 0")).toBe(
      true,
    );
  });

  test("getMediaOptionsByIds reads nothing for an empty id list", async () => {
    expect(await getMediaOptionsByIds([])).toEqual([]);
  });

  // A mistyped Media id reaches the picker as a plain string, and `WHERE id IN
  // (...)` on the `uuid` column answers a non-UUID with an error, not an empty
  // set. The referenced ids are filtered before the query, so a refused save
  // re-renders instead of becoming a 500 (review r1-1).
  test("listPickerMedia drops a referenced id that isn't a UUID", async () => {
    const result = await createMedia({
      bytes: await makeJpeg(80, 60),
      alt: "A photo",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!result.ok) throw new Error("upload failed");

    const picker = await listPickerMedia({
      photo: { mediaId: "not-a-uuid" },
      other: { mediaId: result.media.id },
    });

    // The bad reference is never queried for; the real one is still carried.
    expect(picker.media.map((option) => option.id)).toEqual([result.media.id]);
    expect(picker.capped).toBe(false);
  });

  test("refuses an animated WebP", async () => {
    const result = await createMedia({
      bytes: animatedWebpBytes(),
      alt: "A loop",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/Animated images/);
    expect(await listMedia()).toHaveLength(0);
  });

  test("refuses an APNG", async () => {
    const result = await createMedia({
      bytes: apngBytes(),
      alt: "A loop",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/Animated images/);
    expect(await listMedia()).toHaveLength(0);
  });

  test("requires alt text and writes nothing without it", async () => {
    const storage = createMemoryMediaStorage();
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "   ",
      actorId: null,
      storage,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ field: "alt" }],
    });
    expect(storage.objects.size).toBe(0);
    expect(await listMedia()).toHaveLength(0);
  });

  test("refuses SVG", async () => {
    const result = await createMedia({
      bytes: svgBytes(),
      alt: "A logo",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/SVG/);
  });

  test("refuses alt text over the cap, before storing anything", async () => {
    const storage = createMemoryMediaStorage();
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "x".repeat(MAX_ALT_LENGTH + 1),
      actorId: null,
      storage,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ field: "alt" }],
    });
    expect(storage.objects.size).toBe(0);
    expect(await listMedia()).toHaveLength(0);
  });

  test("refuses GIF, animated or not", async () => {
    const result = await createMedia({
      bytes: gifBytes(),
      alt: "A loop",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/GIF/);
  });

  test("refuses a file that isn't an image at all", async () => {
    const result = await createMedia({
      bytes: new TextEncoder().encode("not an image"),
      alt: "Nope",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/JPEG, PNG or WebP/);
  });

  test("refuses a file over 20 MB before reading it", async () => {
    const result = await createMedia({
      bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      alt: "Huge",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/larger than 20 MB/);
  });

  test("refuses an image whose header claims more than the pixel cap", async () => {
    const result = await createMedia({
      bytes: fakePngHeader(20000, 20000),
      alt: "Bomb",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/too large to process/);
  });

  test("refuses an upload when storage isn't configured", async () => {
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Unconfigured",
      actorId: null,
      storage: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/aren't set up/);
  });
});

describe("editing media", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  const upload = async (): Promise<string> => {
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Original alt",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!result.ok) throw new Error("upload failed");
    return result.media.id;
  };

  test("updates the alt text and refuses a blank one", async () => {
    const id = await upload();

    const updated = await updateMediaAlt(id, "  A new alt  ");
    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(updated.media.alt).toBe("A new alt");

    const refused = await updateMediaAlt(id, "   ");
    expect(refused.ok).toBe(false);
    const stored = await getMediaById(id);
    expect(stored?.alt).toBe("A new alt");
  });

  test("refuses alt text over the cap and leaves the stored one alone", async () => {
    const id = await upload();

    const refused = await updateMediaAlt(id, "x".repeat(MAX_ALT_LENGTH + 1));
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) return;
    expect(refused.message).toMatch(/1000 characters or fewer/);

    const stored = await getMediaById(id);
    expect(stored?.alt.length).toBeLessThanOrEqual(MAX_ALT_LENGTH);
    expect(stored?.alt).not.toBe("x".repeat(MAX_ALT_LENGTH + 1));
  });

  test("clamps the focal point into the image", async () => {
    const id = await upload();

    const updated = await updateMediaFocalPoint(id, { x: 1.7, y: -0.4 });
    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(updated.media.focalX).toBe(1);
    expect(updated.media.focalY).toBe(0);
  });

  test("bumps content_version so the site drops its cached alt and focal point", async () => {
    const id = await upload();
    const version = async (): Promise<number> => {
      const rows = (await db`
        SELECT content_version FROM cms_meta WHERE id = 1
      `) as { content_version: string | number }[];
      return Number(rows[0].content_version);
    };

    const before = await version();
    await updateMediaAlt(id, "A new alt");
    expect(await version()).toBe(before + 1);

    await updateMediaFocalPoint(id, { x: 0.2, y: 0.8 });
    expect(await version()).toBe(before + 2);
  });
});

describe("image guidance", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  test("refuses a save whose image is smaller than the field wants", async () => {
    await seedBlockType(db, guidedBlock);
    const slotId = await seedSlot(db, {
      name: "home.banner",
      blockName: "banner",
      page: "home",
    });

    const small = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Too small",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!small.ok) throw new Error("upload failed");

    const refused = await saveSlotDraft({
      slotId,
      content: { heading: "Hi", photo: { mediaId: small.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "invalid") return;
    expect(refused.issues[0]?.message).toMatch(/1600px/);

    const big = await createMedia({
      bytes: await makeJpeg(2000, 1000),
      alt: "Big enough",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!big.ok) throw new Error("upload failed");

    const saved = await saveSlotDraft({
      slotId,
      content: { heading: "Hi", photo: { mediaId: big.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(saved.ok).toBe(true);
  });

  test("enforces guidance on the page save path too", async () => {
    await seedBlockType(db, guidedBlock);
    await seedPageType(
      db,
      pageType("landing", { allowedBlocks: [guidedBlock] }),
    );
    const created = await createPage({
      pageType: "landing",
      url: "/landing",
      title: "Landing",
    });
    if (!created.ok) throw new Error("page create failed");

    const small = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Too small",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!small.ok) throw new Error("upload failed");

    const refused = await savePageDraft({
      pageId: created.page.id,
      content: {
        blocks: [
          { type: "banner", heading: "Hi", photo: { mediaId: small.media.id } },
        ],
      },
      baseRevisionId: null,
      actorId: null,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "invalid") return;
    expect(refused.issues[0]?.path).toBe("blocks.0.photo.mediaId");
    expect(refused.issues[0]?.message).toMatch(/1600px/);
  });

  test("refuses a save whose image is the wrong aspect, and accepts the right one", async () => {
    await seedBlockType(db, squareBlock);
    const slotId = await seedSlot(db, {
      name: "home.square",
      blockName: "square",
      page: "home",
    });

    const wide = await createMedia({
      bytes: await makeJpeg(1600, 900),
      alt: "Wide",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!wide.ok) throw new Error("upload failed");

    const refused = await saveSlotDraft({
      slotId,
      content: { photo: { mediaId: wide.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "invalid") return;
    expect(refused.issues[0]?.message).toMatch(/1:1/);

    const square = await createMedia({
      bytes: await makeJpeg(1000, 1000),
      alt: "Square",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!square.ok) throw new Error("upload failed");

    const saved = await saveSlotDraft({
      slotId,
      content: { photo: { mediaId: square.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(saved.ok).toBe(true);
  });
});

describe("media usage and delete protection", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  test("a published image can't be deleted; an unused one can", async () => {
    await seedBlockType(db, photoBlock);
    const slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });

    const storage = createMemoryMediaStorage();
    const used = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "In use",
      actorId: null,
      storage,
    });
    if (!used.ok) throw new Error("upload failed");

    const saved = await saveSlotDraft({
      slotId,
      content: { heading: "Hello", photo: { mediaId: used.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(saved.ok).toBe(true);
    const published = await publishSlot({ slotId });
    expect(published.ok).toBe(true);

    const usage = await getMediaUsage(used.media.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "slot", id: slotId });

    const refused = await deleteMedia(used.media.id, storage);
    expect(refused).toMatchObject({ ok: false, reason: "in-use" });
    expect(await getMediaById(used.media.id)).not.toBeNull();

    const unused = await createMedia({
      bytes: await makeJpeg(400, 400),
      alt: "Unused",
      actorId: null,
      storage,
    });
    if (!unused.ok) throw new Error("upload failed");
    const keyCount = storage.objects.size;

    const deleted = await deleteMedia(unused.media.id, storage);
    expect(deleted.ok).toBe(true);
    expect(await getMediaById(unused.media.id)).toBeNull();
    // The unused image's objects went too, and the in-use image's stayed.
    expect(storage.objects.size).toBeLessThan(keyCount);
    expect(storage.objects.has(used.media.objectKey)).toBe(true);
  });

  // The interleaving the row locks close: a delete that starts while a publish
  // is mid-write must wait, then see the published reference and refuse.
  test("a delete waits for a publish holding the image, then refuses", async () => {
    await seedBlockType(db, photoBlock);
    const slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });

    const storage = createMemoryMediaStorage();
    const used = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "In use",
      actorId: null,
      storage,
    });
    if (!used.ok) throw new Error("upload failed");

    const saved = await saveSlotDraft({
      slotId,
      content: { heading: "Hello", photo: { mediaId: used.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    if (!saved.ok) throw new Error("save failed");

    // Hold the share lock a publish takes and point the slot at the revision
    // that uses the image, without committing: a publish mid-write.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.begin(async (tx) => {
      await tx`SELECT id FROM cms_media WHERE id = ${used.media.id} FOR SHARE`;
      await tx`
        UPDATE cms_slots
        SET published_revision_id = ${saved.revision.id}
        WHERE id = ${slotId}
      `;
      await gate;
    });
    await Bun.sleep(100);

    const deleting = deleteMedia(used.media.id, storage);
    await Bun.sleep(100);
    release();
    await holding;

    const result = await deleting;
    expect(result).toMatchObject({ ok: false, reason: "in-use" });
    expect(await getMediaById(used.media.id)).not.toBeNull();
  });

  // Q1: an image can be deleted while only a draft references it. Publishing
  // that draft must refuse — with the message on the block — so a live page
  // never points at a file that is gone. Saving the draft stays legal, so the
  // editor can still pick another image.
  test("refuses to publish a slot draft whose image was deleted", async () => {
    await seedBlockType(db, photoBlock);
    const slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });

    const storage = createMemoryMediaStorage();
    const uploaded = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Gone soon",
      actorId: null,
      storage,
    });
    if (!uploaded.ok) throw new Error("upload failed");

    const saved = await saveSlotDraft({
      slotId,
      content: { heading: "Hello", photo: { mediaId: uploaded.media.id } },
      baseRevisionId: null,
      actorId: null,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // Only a draft references it, so the delete is allowed.
    expect(await deleteMedia(uploaded.media.id, storage)).toMatchObject({
      ok: true,
    });

    // Saving the draft again is still allowed: the editor isn't locked out of
    // fixing it.
    const resaved = await saveSlotDraft({
      slotId,
      content: { heading: "Hello", photo: { mediaId: uploaded.media.id } },
      baseRevisionId: saved.revision.id,
      actorId: null,
    });
    expect(resaved.ok).toBe(true);

    const before = (
      (await db`
        SELECT content_version FROM cms_meta WHERE id = 1
      `) as { content_version: string | number }[]
    )[0].content_version;
    const result = await publishSlot({ slotId });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues).toContainEqual({
      path: "photo.mediaId",
      message: "This image was deleted. Choose another.",
    });

    // Nothing went live and the cache counter didn't move.
    const slots = (await db`
      SELECT published_revision_id FROM cms_slots WHERE id = ${slotId}
    `) as { published_revision_id: string | null }[];
    expect(slots[0].published_revision_id).toBeNull();
    const after = (
      (await db`
        SELECT content_version FROM cms_meta WHERE id = 1
      `) as { content_version: string | number }[]
    )[0].content_version;
    expect(Number(after)).toBe(Number(before));
  });

  test("refuses to publish a page whose block image was deleted", async () => {
    await seedBlockType(db, photoBlock);
    await seedPageType(
      db,
      pageType("landing", { allowedBlocks: [photoBlock] }),
    );
    const created = await createPage({
      pageType: "landing",
      url: "/landing",
      title: "Landing",
    });
    if (!created.ok) throw new Error("page create failed");

    const storage = createMemoryMediaStorage();
    const uploaded = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt: "Gone soon",
      actorId: null,
      storage,
    });
    if (!uploaded.ok) throw new Error("upload failed");

    const saved = await savePageDraft({
      pageId: created.page.id,
      content: {
        blocks: [
          {
            type: "hero",
            heading: "Hi",
            photo: { mediaId: uploaded.media.id },
          },
        ],
      },
      baseRevisionId: null,
      actorId: null,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(await deleteMedia(uploaded.media.id, storage)).toMatchObject({
      ok: true,
    });

    const result = await publishPage({
      pageId: created.page.id,
      revisionId: saved.revision.id,
      requireLatest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "invalid") return;
    expect(result.issues).toContainEqual({
      path: "blocks.0.photo.mediaId",
      message: "This image was deleted. Choose another.",
    });

    const pages = (await db`
      SELECT published_revision_id FROM cms_pages WHERE id = ${created.page.id}
    `) as { published_revision_id: string | null }[];
    expect(pages[0].published_revision_id).toBeNull();
  });
});

// The Done-when path, against a real database: the CMS stores an upload and its
// focal point, and the plugin's reader renders every width and the crop.
describe("the plugin reads what the CMS stored", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  test("renders every width, the focal point and a cache invalidation", async () => {
    const created = await createMedia({
      bytes: await makeJpeg(3000, 1500),
      alt: "A red field",
      actorId: null,
      storage: createMemoryMediaStorage(),
    });
    if (!created.ok) throw new Error("upload failed");
    const id = created.media.id;

    const clock = { now: 0 };
    const reader = createCmsMedia({ sql: db, now: () => clock.now });

    // The centre, read once from the jsonb array the row now holds.
    const first = await reader.getMedia(id);
    expect(first?.focalPoint).toEqual({ x: 0.5, y: 0.5 });
    expect(first?.variants.map((variant) => variant.width)).toEqual([
      480, 960, 1600, 2400, 3000,
    ]);

    const updated = await updateMediaFocalPoint(id, { x: 0.25, y: 0.75 });
    expect(updated.ok).toBe(true);

    // The update bumped content_version; once the poll interval passes the
    // reader re-reads rather than serving the cached centre (r1-3).
    clock.now = 2000;
    const media = await reader.getMedia(id);
    if (!media) throw new Error("media missing after the update");
    expect(media.focalPoint).toEqual({ x: 0.25, y: 0.75 });

    const html = renderCmsImage(media, { alt: "A red field" });
    expect(html).toContain('width="3000"');
    expect(html).toContain('height="1500"');
    expect(html).toContain("object-position:25% 75%");
    for (const width of [480, 960, 1600, 2400, 3000]) {
      expect(html).toContain(`/${width}.webp ${width}w`);
      expect(html).toContain(`/${width}.jpg ${width}w`);
    }
  });
});
