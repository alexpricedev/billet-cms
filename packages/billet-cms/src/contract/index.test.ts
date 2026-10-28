import { describe, expect, test } from "bun:test";
import { block, blockStoredSchema, link, list, text } from "../fields";
import {
  ALLOWED_UPLOAD_TYPES,
  CMS_SIGN_IN_PATH,
  CONTRACT_VERSION,
  DEFAULT_FOCAL_POINT,
  hashJson,
  isCmsRelation,
  MAX_ALT_LENGTH,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
  MEDIA_WIDTHS,
  META_KEYS,
  PREVIEW_QUERY_PARAM,
  PREVIEW_TOKEN_TTL_SECONDS,
  STORED_SCHEMA_FORMAT,
  STORED_SCHEMA_FORMAT_VERSION,
  TABLE_PREFIX,
  TABLES,
} from "./index";

describe("CONTRACT_VERSION", () => {
  test("is set and looks like a version", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("CMS_SIGN_IN_PATH", () => {
  test("is the site path both services agree on, and is site-relative", () => {
    expect(CMS_SIGN_IN_PATH).toBe("/cms/sign-in");
    expect(CMS_SIGN_IN_PATH.startsWith("/")).toBe(true);
  });
});

describe("preview contract", () => {
  test("fixes the query parameter both sides agree on", () => {
    expect(PREVIEW_QUERY_PARAM).toBe("cms_preview");
  });

  test("is short-lived: about half an hour", () => {
    expect(PREVIEW_TOKEN_TTL_SECONDS).toBe(30 * 60);
  });
});

describe("TABLES", () => {
  test("every relation is cms_-prefixed", () => {
    for (const name of Object.values(TABLES)) {
      expect(name.startsWith(TABLE_PREFIX)).toBe(true);
    }
  });

  test("names the relations the CMS owns", () => {
    expect(TABLES).toEqual({
      migrations: "cms_migrations",
      meta: "cms_meta",
      sessions: "cms_sessions",
      userTokens: "cms_user_tokens",
      identities: "cms_identities",
      userPreferences: "cms_user_preferences",
      blockTypes: "cms_block_types",
      pageTypes: "cms_page_types",
      slots: "cms_slots",
      revisions: "cms_revisions",
      handoffTokens: "cms_handoff_tokens",
      pages: "cms_pages",
      redirects: "cms_redirects",
      previewTokens: "cms_preview_tokens",
      media: "cms_media",
      exportTokens: "cms_export_tokens",
      audit: "cms_audit",
    });
  });
});

describe("isCmsRelation", () => {
  test("accepts the CMS's own relations, including future ones", () => {
    expect(isCmsRelation("cms_users")).toBe(true);
    expect(isCmsRelation("cms_block_types")).toBe(true);
    expect(isCmsRelation("cms_revisions")).toBe(true);
  });

  test("rejects the site's names, so a check can't mistake them for ours", () => {
    expect(isCmsRelation("users")).toBe(false);
    expect(isCmsRelation("sessions")).toBe(false);
    expect(isCmsRelation("migrations")).toBe(false);
  });
});

describe("META_KEYS", () => {
  test("names the two counters cms_meta holds", () => {
    expect(META_KEYS.contractVersion).toBe("contract_version");
    expect(META_KEYS.contentVersion).toBe("content_version");
  });
});

describe("media contract", () => {
  test("fixes the rendition ladder both sides build a srcset from", () => {
    expect([...MEDIA_WIDTHS]).toEqual([480, 960, 1600, 2400]);
  });

  test("caps an upload at about 20 MB and a decode at 100 MP", () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_UPLOAD_PIXELS).toBe(100_000_000);
  });

  test("accepts only JPEG, PNG and WebP", () => {
    expect([...ALLOWED_UPLOAD_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(ALLOWED_UPLOAD_TYPES).not.toContain("image/svg+xml");
    expect(ALLOWED_UPLOAD_TYPES).not.toContain("image/gif");
  });

  test("caps alt text so both the stored upload and a per-use override agree", () => {
    expect(MAX_ALT_LENGTH).toBe(1000);
  });

  test("starts a new upload at its centre", () => {
    expect(DEFAULT_FOCAL_POINT).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("stored schema format", () => {
  test("is identified and versioned so an old document can be recognised", () => {
    expect(STORED_SCHEMA_FORMAT).toBe("billet-cms/schema");
    expect(STORED_SCHEMA_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
  });

  // The published document the CMS reads, built the way a site's deploy builds
  // it (`blockStoredSchema`) rather than as a hand-written literal that only
  // proves the interface compiles. This is the contract both sides depend on:
  // the format marker, the JSON Schema the CMS validates against, the field
  // metadata tree it renders a form from, and the hash a re-publish compares.
  test("a real block's published document carries the JSON Schema, the field metadata tree and a schema hash", () => {
    const stored = blockStoredSchema(
      block(
        "hero",
        {
          heading: text({ label: "Heading", max: 80 }),
          links: list(link(), { min: 1, max: 6 }),
        },
        () => null,
      ),
    );

    expect(stored.format).toBe(STORED_SCHEMA_FORMAT);
    expect(stored.version).toBe(STORED_SCHEMA_FORMAT_VERSION);
    expect(stored.name).toBe("hero");
    // The JSON Schema is what the CMS rebuilds a validator from.
    expect(stored.jsonSchema).toMatchObject({ type: "object" });
    expect(stored.fields).toEqual([
      {
        name: "heading",
        kind: "text",
        required: true,
        label: "Heading",
        max: 80,
      },
      {
        name: "links",
        kind: "list",
        required: true,
        min: 1,
        max: 6,
        // The tree: a list's item metadata is nested, so the CMS renders a
        // repeatable control without importing site code.
        of: { name: "item", kind: "link", required: true },
      },
    ]);
    expect(stored.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashJson", () => {
  test("is stable for the same value and changes when a value changes", () => {
    const first = hashJson({ a: 1, b: ["x", "y"] });
    expect(hashJson({ a: 1, b: ["x", "y"] })).toBe(first);
    expect(hashJson({ a: 1, b: ["x", "z"] })).not.toBe(first);
  });

  test("is a hex digest, not the JSON itself", () => {
    expect(hashJson({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sorts object keys recursively, so declaration order doesn't hash differently", () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: { x: 1, y: 2 }, b: [1, 2] })).toBe(
      hashJson({ b: [1, 2], a: { y: 2, x: 1 } }),
    );
  });

  test("still depends on array order and on the values", () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});
