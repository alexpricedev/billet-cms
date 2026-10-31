import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { MAX_UPLOAD_BYTES } from "@alexpricedev/billet-cms/contract";
import { block, image, text } from "@alexpricedev/billet-cms/fields";
import { createMemoryStorage } from "@alexpricedev/billet-storage";
import { createBunRequest } from "../../test-utils/bun-request";
import { seedBlockType, seedSlot } from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { makeJpeg, svgBytes } from "../../test-utils/images";
import { jsonbValue } from "../../utils/sql";

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
  MEDIA_PICKER_LIMIT,
  type MediaRecord,
  setMediaStorageForTest,
  updateMediaFocalPoint,
} from "../../services/media";
import { createAuthenticatedSession } from "../../services/sessions";
import { media } from "./media";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  { label: "Hero" },
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
    headers: Record<string, string> = {},
  ) => {
    body.set("_csrf", await createCsrfToken(sessionId, "POST", csrfPath));
    return createBunRequest(
      `${ORIGIN}${path}`,
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          cookie: `cms_session=${sessionId}`,
          ...headers,
        },
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

  /** The header the picker's drop zone sends, asking for JSON not a page. */
  const JSON_ACCEPT = { Accept: "application/json" };

  /**
   * Insert an upload row without processing an image.
   *
   * Paging needs more than one page of rows; 51 real uploads would run Sharp
   * 51 times for a test about the cursor. `createdAt` is explicit because the
   * cursor orders on it.
   */
  const seedRow = async (alt: string, createdAt: Date): Promise<string> => {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO cms_media
        (id, object_key, content_type, byte_size, width, height, alt, variants,
         created_at)
      VALUES (${id}, ${`media/${id}/original.jpg`}, ${"image/jpeg"}, ${1024},
              ${80}, ${60}, ${alt}, ${jsonbValue([])}, ${createdAt})
    `;
    return id;
  };

  /** One page of the options route's JSON. */
  type OptionsBody = {
    items: {
      id: string;
      alt: string;
      width: number;
      height: number;
      thumbnailUrl: string | null;
    }[];
    next: string | null;
  };

  test("redirects an anonymous visitor to sign in", async () => {
    const res = await media.index(
      createBunRequest(`${ORIGIN}/cms/media`, { method: "GET" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("lists the uploads under the staged-upload drop zone", async () => {
    await upload("A red field");
    const res = await media.index(get("/cms/media"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A red field");
    expect(html).toContain("data-media-upload");
    expect(html).toContain("Choose file");
    expect(html).toContain('src="/assets/media-upload.js"');
  });

  test("answers an upload without Accept: application/json with 406", async () => {
    const form = new FormData();
    form.set("alt", "From a form");
    form.set(
      "file",
      file(await makeJpeg(1200, 800), "photo.jpg", "image/jpeg"),
    );

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media"),
    );
    expect(res.status).toBe(406);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("application/json");
    expect(await db`SELECT id FROM cms_media`).toHaveLength(0);
  });

  test("a JSON upload without alt answers with the alt error", async () => {
    const form = new FormData();
    form.set("alt", "");
    form.set("file", file(await makeJpeg(800, 400), "photo.jpg", "image/jpeg"));

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media", {}, JSON_ACCEPT),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors[0]?.message).toContain("Enter alt text.");
    const rows = (await db`SELECT id FROM cms_media`) as { id: string }[];
    expect(rows).toHaveLength(0);
  });

  test("a JSON upload of an SVG is refused with a clear message", async () => {
    const form = new FormData();
    form.set("alt", "A logo");
    form.set("file", file(svgBytes(), "logo.svg", "image/svg+xml"));

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media", {}, JSON_ACCEPT),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors[0]?.message).toContain("SVG uploads aren't supported");
  });

  test("redirects an anonymous JSON upload to sign in", async () => {
    const form = new FormData();
    form.set("alt", "Anonymous");
    form.set("file", file(await makeJpeg(60, 40), "photo.jpg", "image/jpeg"));

    const res = await media.upload(
      createBunRequest(`${ORIGIN}/cms/media`, {
        method: "POST",
        headers: JSON_ACCEPT,
        body: form,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("a JSON upload without a CSRF token is refused", async () => {
    const form = new FormData();
    form.set("alt", "No token");
    form.set("file", file(await makeJpeg(60, 40), "photo.jpg", "image/jpeg"));

    const res = await media.upload(
      createBunRequest(`${ORIGIN}/cms/media`, {
        method: "POST",
        headers: {
          ...JSON_ACCEPT,
          Origin: ORIGIN,
          cookie: `cms_session=${sessionId}`,
        },
        body: form,
      }),
    );
    expect(res.status).toBe(403);
    expect(await db`SELECT id FROM cms_media`).toHaveLength(0);
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

  test("the options route redirects an anonymous visitor to sign in", async () => {
    const res = await media.options(
      createBunRequest(`${ORIGIN}/cms/media/options`, { method: "GET" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("the options route lists the newest uploads with thumbnails", async () => {
    const older = await upload("Older");
    const newer = await upload("Newer");

    const res = await media.options(get("/cms/media/options"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as OptionsBody;
    expect(body.items.map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(body.next).toBeNull();
    expect(body.items[0]).toMatchObject({
      id: newer.id,
      alt: "Newer",
      width: 800,
      height: 400,
    });
    // The thumbnail is a real rendition URL, not the full-size original.
    expect(body.items[0]?.thumbnailUrl).toContain("https://media.test/");
  });

  test("the options route pages with the cursor and never repeats a row", async () => {
    const base = Date.UTC(2026, 0, 1);
    const ids: string[] = [];
    for (let index = 0; index < MEDIA_PICKER_LIMIT + 1; index += 1) {
      ids.push(await seedRow(`Seed ${index}`, new Date(base + index * 1000)));
    }

    const firstRes = await media.options(get("/cms/media/options"));
    const first = (await firstRes.json()) as OptionsBody;
    expect(first.items).toHaveLength(MEDIA_PICKER_LIMIT);
    expect(first.items[0]?.id).toBe(ids[MEDIA_PICKER_LIMIT]);
    expect(first.items[MEDIA_PICKER_LIMIT - 1]?.id).toBe(ids[1]);
    expect(first.next).not.toBeNull();

    const secondRes = await media.options(
      get(`/cms/media/options?after=${encodeURIComponent(first.next ?? "")}`),
    );
    const second = (await secondRes.json()) as OptionsBody;
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.next).toBeNull();
    expect(
      second.items.some((item) =>
        first.items.some((seen) => seen.id === item.id),
      ),
    ).toBe(false);
  });

  test("the options route searches alt text", async () => {
    await upload("A red field");
    await upload("A blue sky");

    const match = (await (
      await media.options(get("/cms/media/options?q=red"))
    ).json()) as OptionsBody;
    expect(match.items.map((item) => item.alt)).toEqual(["A red field"]);

    const none = (await (
      await media.options(get("/cms/media/options?q=green"))
    ).json()) as OptionsBody;
    expect(none.items).toEqual([]);
    expect(none.next).toBeNull();
  });

  test("a JSON upload answers with the row instead of redirecting", async () => {
    const form = new FormData();
    form.set("alt", "Dropped in");
    form.set(
      "file",
      file(await makeJpeg(1200, 800), "photo.jpg", "image/jpeg"),
    );

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media", {}, JSON_ACCEPT),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      id: string;
      alt: string;
      width: number;
      height: number;
      thumbnailUrl: string | null;
    };
    expect(body.alt).toBe("Dropped in");
    expect(body.width).toBe(1200);
    expect(body.height).toBe(800);
    expect(body.thumbnailUrl).toContain("https://media.test/");
    expect(await getMediaById(body.id)).not.toBeNull();
  });

  test("a JSON upload that is too large answers with the file error", async () => {
    const form = new FormData();
    form.set("alt", "Too big");
    form.set(
      "file",
      file(new Uint8Array(MAX_UPLOAD_BYTES + 1), "big.jpg", "image/jpeg"),
    );

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media", {}, JSON_ACCEPT),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors[0]?.field).toBe("file");
    expect(body.errors[0]?.message).toMatch(/larger than 20 MB/);
    expect(await db`SELECT id FROM cms_media`).toHaveLength(0);
  });

  test("a JSON upload that is not an image answers with the file error", async () => {
    const form = new FormData();
    form.set("alt", "Not a picture");
    form.set(
      "file",
      file(new TextEncoder().encode("not an image"), "notes.txt", "text/plain"),
    );

    const res = await media.upload(
      await post("/cms/media", form, "/cms/media", {}, JSON_ACCEPT),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors[0]?.field).toBe("file");
    expect(body.errors[0]?.message).toContain(
      "isn't a JPEG, PNG or WebP image",
    );
  });

  test("an expired upload token gets a fresh one in the JSON answer", async () => {
    // A token from three 15-minute buckets ago: authentic, so recoverable, but
    // too old to perform the write.
    const realNow = Date.now;
    Date.now = () => realNow() - 3 * 15 * 60 * 1000;
    let stale: string;
    try {
      stale = await createCsrfToken(sessionId, "POST", "/cms/media");
    } finally {
      Date.now = realNow;
    }

    const form = new FormData();
    form.set("alt", "Dropped in");
    form.set("file", file(await makeJpeg(60, 40), "photo.jpg", "image/jpeg"));

    const res = await media.upload(
      await post(
        "/cms/media",
        form,
        "/cms/media",
        {},
        {
          ...JSON_ACCEPT,
          "X-CSRF-Token": stale,
        },
      ),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-csrf-token")).toBeTruthy();
    const body = (await res.json()) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors[0]?.message).toContain("This page expired");
    // Nothing was written on the stale request.
    expect(await db`SELECT id FROM cms_media`).toHaveLength(0);
  });
});

/** The in-memory storage the controller's upload writes through. */
const createStorage = () =>
  createMemoryStorage({ publicBaseUrl: "https://media.test" });
