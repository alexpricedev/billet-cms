import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
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
      users: "cms_users",
      sessions: "cms_sessions",
      userTokens: "cms_user_tokens",
      identities: "cms_identities",
    });
  });
});

describe("isCmsRelation", () => {
  test("accepts the CMS's own relations, including future ones", () => {
    expect(isCmsRelation("cms_users")).toBe(true);
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

  test("carries the JSON Schema and the field metadata the form needs", () => {
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
      ],
    };

    expect(document.format).toBe(STORED_SCHEMA_FORMAT);
    expect(document.version).toBe(STORED_SCHEMA_FORMAT_VERSION);
    expect(document.fields[0]?.name).toBe("heading");
  });
});
