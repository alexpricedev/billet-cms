import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, image, text } from "@alexpricedev/billet-cms/fields";
import { createMemoryStorage } from "@alexpricedev/billet-storage";
import { createBunRequest } from "../../test-utils/bun-request";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { makeJpeg, svgBytes } from "../../test-utils/images";

const connection = testDatabase();

mock.module("../../services/database", () => ({
  get db() {
    return connection;
  },
}));

import { publishSlot, saveSlotDraft } from "../../services/content";
import { createCsrfToken } from "../../services/csrf";
import { db } from "../../services/database";
import {
  createMedia,
  getMediaById,
  type MediaRecord,
  setMediaStorageForTest,
  updateMediaFocalPoint,
} from "../../services/media";
import { createAuthenticatedSession } from "../../services/sessions";
import { media } from "./media";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  { heading: text({ max: 80 }), photo: image() },
  () => null,
);

describe("Media controller", () => {
  let editorId: string;
  let sessionId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    editorId = (await seedIdentity(db, "editor@example.com")).id;
    sessionId = await createAuthenticatedSession(editorId);
    setMediaStorageForTest(createStorage());
  });

  afterAll(async () => {
    setMediaStorageForTest(undefined);
    await connection.end();
    mock.restore();
  });

  const get = (path: string) =>
    createBunRequest(`${ORIGIN}${path}`, {
      method: "GET",
      headers: { cookie: `cms_session=${sessionId}` },
    });

  const post = async (
    path: string,
    body: FormData,
    csrfPath: string,
    params: Record<string, string> = {},
  ) => {
    body.set("_csrf", await createCsrfToken(sessionId, "POST", csrfPath));
    return createBunRequest(
      `${ORIGIN}${path}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, cookie: `cms_session=${sessionId}` },
        body,
      },
      params,
    );
  };

  const upload = async (alt = "A photo"): Promise<MediaRecord> => {
    const result = await createMedia({
      bytes: await makeJpeg(800, 400),
      alt,
      actorId: editorId,
    });
    if (!result.ok) throw new Error("seed upload failed");
    return result.media;
  };

  /** A multipart File from raw bytes, typed as BlobPart for TS 7. */
  const file = (bytes: Uint8Array, name: string, type: string): File =>
    new File([bytes as unknown as BlobPart], name, { type });

  test("redirects an anonymous visitor to sign in", async () => {
    const res = await media.index(
      createBunRequest(`${ORIGIN}/cms/media`, { method: "GET" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("lists the uploads", async () => {
    await upload("A red field");
    const res = await media.index(get("/cms/media"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A red field");
    expect(html).toContain("Upload");
  });

  test("uploads a JPEG and redirects to the list", async () => {
    const form = new FormData();
    form.set("alt", "From the form");
    form.set(
      "file",
      file(await makeJpeg(1200, 800), "photo.jpg", "image/jpeg"),
    );

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cms/media?uploaded=1");

    const rows = (await db`
      SELECT alt FROM cms_media
    `) as { alt: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].alt).toBe("From the form");
  });

  test("re-renders with a message when alt is missing", async () => {
    const form = new FormData();
    form.set("alt", "");
    form.set("file", file(await makeJpeg(800, 400), "photo.jpg", "image/jpeg"));

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Enter alt text.");
    const rows = (await db`SELECT id FROM cms_media`) as { id: string }[];
    expect(rows).toHaveLength(0);
  });

  test("refuses an SVG upload with a clear message", async () => {
    const form = new FormData();
    form.set("alt", "A logo");
    form.set("file", file(svgBytes(), "logo.svg", "image/svg+xml"));

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SVG uploads aren't supported");
  });

  test("saves the alt text and the focal point", async () => {
    const image = await upload("Old alt");

    const form = new FormData();
    form.set("alt", "New alt");
    form.set("focal_x", "0.2");
    form.set("focal_y", "0.8");

    const res = await media.save(
      await post(`/cms/media/${image.id}`, form, `/cms/media/${image.id}`, {
        id: image.id,
      }),
    );
    expect(res.status).toBe(303);

    const saved = await getMediaById(image.id);
    expect(saved?.alt).toBe("New alt");
    expect(saved?.focalX).toBeCloseTo(0.2);
    expect(saved?.focalY).toBeCloseTo(0.8);
  });

  test("leaves the focal point alone when the form omits it", async () => {
    const image = await upload("Old alt");
    // A stored crop away from the centre, so "unchanged" is distinguishable
    // from the "0,0" a missing input would read as with a bare Number().
    await updateMediaFocalPoint(image.id, { x: 0.25, y: 0.75 });

    const form = new FormData();
    form.set("alt", "New alt");

    const res = await media.save(
      await post(`/cms/media/${image.id}`, form, `/cms/media/${image.id}`, {
        id: image.id,
      }),
    );
    expect(res.status).toBe(303);

    const saved = await getMediaById(image.id);
    expect(saved?.alt).toBe("New alt");
    expect(saved?.focalX).toBeCloseTo(0.25);
    expect(saved?.focalY).toBeCloseTo(0.75);
  });

  test("won't delete an image published content still uses", async () => {
    await seedBlockType(db, hero);
    const slotId = await seedSlot(db, {
      name: "home.hero",
      blockName: "hero",
      page: "home",
    });

    const image = await upload("In use");
    await saveSlotDraft({
      slotId,
      content: { heading: "Hello", photo: { mediaId: image.id } },
      baseRevisionId: null,
      actorId: editorId,
    });
    await publishSlot({ slotId });

    const form = new FormData();
    const res = await media.destroy(
      await post(
        `/cms/media/${image.id}/delete`,
        form,
        `/cms/media/${image.id}/delete`,
        { id: image.id },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/cms/media/${image.id}?in-use=1`);
    expect(await getMediaById(image.id)).not.toBeNull();
  });

  test("deletes an unused image", async () => {
    const image = await upload("Unused");

    const form = new FormData();
    const res = await media.destroy(
      await post(
        `/cms/media/${image.id}/delete`,
        form,
        `/cms/media/${image.id}/delete`,
        { id: image.id },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cms/media?deleted=1");
    expect(await getMediaById(image.id)).toBeNull();
  });
});

/** The in-memory storage the controller's upload writes through. */
const createStorage = () =>
  createMemoryStorage({ publicBaseUrl: "https://media.test" });
