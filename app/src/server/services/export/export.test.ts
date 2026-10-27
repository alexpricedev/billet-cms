import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CONTRACT_VERSION,
  type MediaVariant,
} from "@alexpricedev/billet-cms/contract";
import { block, image, text } from "@alexpricedev/billet-cms/fields";
import type { SQL } from "bun";
import {
  seedBlockType,
  seedPageType,
  seedSlot,
} from "../../test-utils/content";
import { testDatabase } from "../../test-utils/database";
import { cleanupTestData, seedIdentity } from "../../test-utils/helpers";
import { jsonbValue } from "../../utils/sql";

const connection = testDatabase();

mock.module("../database", () => ({
  get db() {
    return connection;
  },
  closeDatabase: async () => {},
}));

import { db } from "../database";
import { buildExport } from "./export";
import {
  createExportToken,
  ExportTokenLabelError,
  listExportTokens,
  MAX_EXPORT_TOKEN_LABEL_LENGTH,
  revokeExportToken,
  verifyExportToken,
} from "./tokens";

const hero = block(
  "hero",
  { heading: text({ max: 80 }), photo: image() },
  () => null,
);

interface Inserted {
  slotId: string;
  pageId: string;
  mediaId: string;
  publishedSlotRevision: string;
  draftSlotRevision: string;
  publishedPageRevision: string;
  draftPageRevision: string;
}

const VARIANT: MediaVariant = {
  width: 960,
  height: 540,
  webpKey: "media/x/960.webp",
  webpUrl: "https://bucket.example/media/x/960.webp",
  fallbackKey: "media/x/960.jpg",
  fallbackUrl: "https://bucket.example/media/x/960.jpg",
};

const seed = async (actorId: string): Promise<Inserted> => {
  await seedBlockType(db, hero);
  await seedPageType(db, {
    kind: "pageType",
    name: "landing",
    allowedBlocks: [hero],
    requiredBlocks: [],
    limits: { hero: { max: 1 } },
  });
  const slotId = await seedSlot(db, {
    name: "home.hero",
    blockName: "hero",
    page: "home",
  });

  const mediaRows = (await db`
    INSERT INTO cms_media
      (object_key, content_type, byte_size, width, height, alt, variants)
    VALUES (
      'media/x/original.webp', 'image/webp', 1234, 1920, 1080, 'A field',
      ${jsonbValue([VARIANT])}
    )
    RETURNING id
  `) as { id: string }[];
  const mediaId = mediaRows[0].id;

  const content = {
    heading: "Hello",
    photo: { mediaId, alt: "Override alt" },
  };

  const insertRevision = async (
    targetType: "page" | "slot",
    targetId: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const rows = (await db`
      INSERT INTO cms_revisions (target_type, target_id, content, created_by)
      VALUES (${targetType}, ${targetId}, ${jsonbValue(body)}, ${actorId})
      RETURNING id
    `) as { id: string }[];
    return rows[0].id;
  };

  const publishedSlotRevision = await insertRevision("slot", slotId, content);
  const draftSlotRevision = await insertRevision("slot", slotId, {
    heading: "Draft change",
    photo: { mediaId },
  });
  await db`
    UPDATE cms_slots SET published_revision_id = ${publishedSlotRevision}
    WHERE id = ${slotId}
  `;

  const pageRows = (await db`
    INSERT INTO cms_pages (page_type, url, title, seo_description)
    VALUES ('landing', '/about', 'About', 'About us')
    RETURNING id
  `) as { id: string }[];
  const pageId = pageRows[0].id;
  const publishedPageRevision = await insertRevision("page", pageId, {
    blocks: [{ type: "hero", heading: "About", photo: { mediaId } }],
  });
  const draftPageRevision = await insertRevision("page", pageId, {
    blocks: [{ type: "hero", heading: "Draft about" }],
  });
  await db`
    UPDATE cms_pages SET published_revision_id = ${publishedPageRevision}
    WHERE id = ${pageId}
  `;

  // A page that only ever had drafts: no published revision, so it must not
  // appear in the export at all.
  await db`
    INSERT INTO cms_pages (page_type, url, title)
    VALUES ('landing', '/never-published', 'Never published')
  `;

  await db`
    INSERT INTO cms_redirects (from_path, to_page_id)
    VALUES ('/old-about', ${pageId})
  `;

  return {
    slotId,
    pageId,
    mediaId,
    publishedSlotRevision,
    draftSlotRevision,
    publishedPageRevision,
    draftPageRevision,
  };
};

describe("export document", () => {
  let actorId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    actorId = (await seedIdentity(db, "editor@example.com")).id;
  });

  test("carries published content only", async () => {
    const ids = await seed(actorId);
    const document = await buildExport();

    // Envelope.
    expect(document.format).toBe("billet-cms/export");
    expect(document.version).toBe(1);
    // The constant, not a literal: the assertion is that the export stamps the
    // contract it was written against, and pinning the number here only means
    // a bump fails a test about something else.
    expect(document.contractVersion).toBe(CONTRACT_VERSION);
    // The keys are exactly the scope guarantee: there is nowhere for a draft,
    // a user, a session or a token to hide.
    expect(Object.keys(document).sort()).toEqual([
      "contentVersion",
      "contractVersion",
      "exportedAt",
      "format",
      "media",
      "pages",
      "redirects",
      "revisions",
      "slots",
      "version",
    ]);

    // Only the published page, not the draft-only one.
    expect(document.pages.map((page) => page.url)).toEqual(["/about"]);
    expect(document.pages[0].publishedRevisionId).toBe(
      ids.publishedPageRevision,
    );

    // Only the published slot.
    expect(document.slots.map((slot) => slot.name)).toEqual(["home.hero"]);
    expect(document.slots[0].publishedRevisionId).toBe(
      ids.publishedSlotRevision,
    );

    // Revisions are exactly the two published ones: no draft leaked.
    const revisionIds = document.revisions
      .map((revision) => revision.id)
      .sort();
    expect(revisionIds).toEqual(
      [ids.publishedPageRevision, ids.publishedSlotRevision].sort(),
    );
    expect(revisionIds).not.toContain(ids.draftSlotRevision);
    expect(revisionIds).not.toContain(ids.draftPageRevision);

    // The redirect and the media row ride along; images keep their bucket URLs.
    expect(document.redirects.map((redirect) => redirect.fromPath)).toEqual([
      "/old-about",
    ]);
    expect(document.media).toHaveLength(1);
    expect(document.media[0].variants[0].fallbackUrl).toBe(
      "https://bucket.example/media/x/960.jpg",
    );
  });

  // The whole document is one snapshot: every read runs in a single read-only
  // REPEATABLE READ transaction, so a publish landing mid-read can't show
  // half-old, half-new content.
  test("reads the document in one read-only, repeatable-read transaction", async () => {
    await seed(actorId);

    let begins = 0;
    let isolation: string | undefined;
    let readOnly: string | undefined;
    const wrapped = new Proxy(connection, {
      get(target, property, receiver) {
        if (property === "begin") {
          return (options: string, fn: (tx: SQL) => Promise<unknown>) => {
            begins += 1;
            return target.begin(options, async (tx) => {
              const iso = (await tx.unsafe("SHOW transaction_isolation")) as {
                transaction_isolation: string;
              }[];
              const ro = (await tx.unsafe("SHOW transaction_read_only")) as {
                transaction_read_only: string;
              }[];
              isolation = iso[0].transaction_isolation;
              readOnly = ro[0].transaction_read_only;
              return fn(tx);
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SQL;

    const document = await buildExport(wrapped);

    expect(begins).toBe(1);
    expect(isolation).toBe("repeatable read");
    expect(readOnly).toBe("on");
    expect(document.pages.map((page) => page.url)).toEqual(["/about"]);
  });

  // Without an ORDER BY, Postgres may return the revision rows in any order and
  // two exports of the same content would diff. The order is the id.
  test("orders the revisions by id, deterministically", async () => {
    const ids = await seed(actorId);

    const first = await buildExport();
    const second = await buildExport();
    const expected = [
      ids.publishedPageRevision,
      ids.publishedSlotRevision,
    ].sort();

    expect(first.revisions.map((revision) => revision.id)).toEqual(expected);
    expect(second.revisions.map((revision) => revision.id)).toEqual(expected);
  });

  test("exports no user, session or token rows", async () => {
    await seed(actorId);
    await createExportToken({ label: "laptop", actorId });

    const document = await buildExport();
    const json = JSON.stringify(document);
    // Secrets of the CMS's auth surface never appear, by key or by value.
    expect(json).not.toContain("cms_sessions");
    expect(json).not.toContain("cms_export_tokens");
    expect(json).not.toContain("editor@example.com");
  });
});

describe("export tokens", () => {
  let actorId: string;

  beforeEach(async () => {
    await cleanupTestData(db);
    actorId = (await seedIdentity(db, "editor@example.com")).id;
  });

  test("creates a token, returns the raw value once, and stores only its hash", async () => {
    const created = await createExportToken({
      label: "Alex's laptop",
      actorId,
    });
    expect(created.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.token.label).toBe("Alex's laptop");

    // The raw token never comes back from a read.
    const listed = await listExportTokens();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.rawToken);

    // A created audit row names it.
    const audit = (await db`
      SELECT action FROM cms_audit ORDER BY created_at
    `) as { action: string }[];
    expect(audit.map((row) => row.action)).toEqual(["export_token.created"]);
  });

  test("verifies a live token, stamps last-used, and refuses a revoked one", async () => {
    const created = await createExportToken({ label: "laptop", actorId });

    const verified = await verifyExportToken(created.rawToken);
    expect(verified?.id).toBe(created.token.id);
    expect(verified?.lastUsedAt).not.toBeNull();

    const revoked = await revokeExportToken(created.token.id, actorId);
    expect(revoked.ok).toBe(true);

    expect(await verifyExportToken(created.rawToken)).toBeNull();
    // The row is retained so the audit keeps a name for it.
    const listed = await listExportTokens();
    expect(listed[0].revokedAt).not.toBeNull();
  });

  test("refuses an unknown token", async () => {
    expect(await verifyExportToken("not-a-real-token")).toBeNull();
  });

  test("refuses an empty or over-long label before writing", async () => {
    await expect(
      createExportToken({ label: "   ", actorId }),
    ).rejects.toBeInstanceOf(ExportTokenLabelError);
    await expect(
      createExportToken({
        label: "x".repeat(MAX_EXPORT_TOKEN_LABEL_LENGTH + 1),
        actorId,
      }),
    ).rejects.toBeInstanceOf(ExportTokenLabelError);

    // A label of exactly the limit is fine, and nothing was written by the
    // refusals above.
    const allowed = await createExportToken({
      label: "x".repeat(MAX_EXPORT_TOKEN_LABEL_LENGTH),
      actorId,
    });
    expect(allowed.token.label).toHaveLength(MAX_EXPORT_TOKEN_LABEL_LENGTH);
    expect(await listExportTokens()).toHaveLength(1);
  });
});

afterAll(async () => {
  await connection.end();
  mock.restore();
});
