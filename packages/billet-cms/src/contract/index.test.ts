import { describe, expect, test } from "bun:test";
import {
  CMS_SIGN_IN_PATH,
  CONTRACT_VERSION,
  hashJson,
  isCmsRelation,
  META_KEYS,
  STORED_SCHEMA_FORMAT,
  STORED_SCHEMA_FORMAT_VERSION,
  type StoredSchema,
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
      blockTypes: "cms_block_types",
      pageTypes: "cms_page_types",
      slots: "cms_slots",
      revisions: "cms_revisions",
      handoffTokens: "cms_handoff_tokens",
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

describe("stored schema format", () => {
  test("is identified and versioned so an old document can be recognised", () => {
    expect(STORED_SCHEMA_FORMAT).toBe("billet-cms/schema");
    expect(STORED_SCHEMA_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
  });

  test("carries the JSON Schema, the field metadata tree and a schema hash", () => {
    const document: StoredSchema = {
      format: STORED_SCHEMA_FORMAT,
      version: STORED_SCHEMA_FORMAT_VERSION,
      name: "hero",
      jsonSchema: { type: "object", properties: {} },
      fields: [
        {
          name: "heading",
          kind: "text",
          label: "Heading",
          max: 80,
          required: true,
        },
        {
          name: "links",
          kind: "list",
          required: true,
          min: 1,
          max: 6,
          of: { name: "item", kind: "link", required: true },
        },
      ],
      schemaHash: "abc123",
    };

    expect(document.format).toBe(STORED_SCHEMA_FORMAT);
    expect(document.version).toBe(STORED_SCHEMA_FORMAT_VERSION);
    expect(document.fields[0]?.name).toBe("heading");
    // The tree: a list's item metadata is nested, so the CMS renders a
    // repeatable control without importing site code.
    expect(document.fields[1]?.of?.kind).toBe("link");
    expect(document.schemaHash).toBe("abc123");
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
