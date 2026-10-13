import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import { block, image, text } from "@alexpricedev/billet-cms/fields";
import sharp from "sharp";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData } from "../../test-utils/helpers";
import {
  fakePngHeader,
  gifBytes,
  makeJpeg,
  svgBytes,
  withExif,
} from "../../test-utils/images";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
}));

import { publishSlot, saveSlotDraft } from "../content";
import { db } from "../database";
import {
  createMedia,
  deleteMedia,
  getMediaById,
  getMediaUsage,
  listMedia,
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

  test("clamps the focal point into the image", async () => {
    const id = await upload();

    const updated = await updateMediaFocalPoint(id, { x: 1.7, y: -0.4 });
    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(updated.media.focalX).toBe(1);
    expect(updated.media.focalY).toBe(0);
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
});
