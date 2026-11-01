import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { block, text } from "@alexpricedev/billet-cms/fields";
import { createBunRequest } from "../test-utils/bun-request";
import { seedBlockType, seedSlot } from "../test-utils/content";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("../services/database", () => ({
  get db() {
    return connection;
  },
  closeDatabase: async () => {},
}));

import { clearRateLimitLog } from "../middleware/rate-limit";
import { db } from "../services/database";
import {
  createExportToken,
  createExportTokenNonce,
  revokeExportToken,
} from "../services/export";
import { EXPORT_RATE_LIMIT, exportApi } from "./export";

const ORIGIN = process.env.APP_URL as string;

const hero = block(
  "hero",
  { label: "Hero" },
  { heading: text({ max: 80 }) },
  () => null,
);

const get = (authorization?: string) =>
  createBunRequest(`${ORIGIN}/export`, {
    method: "GET",
    ...(authorization ? { headers: { authorization } } : {}),
  });

describe("GET /export", () => {
  let actorId: string;

  const createToken = async (label: string) => {
    const created = await createExportToken({
      label,
      nonce: createExportTokenNonce(),
      actorId,
    });
    if (!created.ok) {
      throw new Error(`createExportToken refused: ${created.reason}`);
    }
    return created;
  };

  beforeEach(async () => {
    // The rate limiter's log outlives a test; without this the 429 case would
    // spend the budget for every case after it.
    clearRateLimitLog();
    await cleanupTestData(db);
    actorId = (await seedIdentity(db, "editor@example.com")).id;
    await seedBlockType(db, hero);
    await seedSlot(db, { name: "home.hero", blockName: "hero", page: "home" });
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("refuses a request with no token", async () => {
    const response = await exportApi.index(get());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  test("refuses an unknown token", async () => {
    const response = await exportApi.index(get("Bearer nope"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("invalid_token");
  });

  test("refuses a revoked token", async () => {
    const created = await createToken("laptop");
    await revokeExportToken(created.token.id, actorId);

    const response = await exportApi.index(get(`Bearer ${created.rawToken}`));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("invalid_token");
  });

  test("returns the export document and records the read", async () => {
    const created = await createToken("laptop");

    const response = await exportApi.index(get(`Bearer ${created.rawToken}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.format).toBe("billet-cms/export");
    // A slot with no published revision carries no content, but the envelope is
    // complete.
    expect(Array.isArray(body.slots)).toBe(true);

    const audit = (await db`
      SELECT action, actor_id, subject_type FROM cms_audit
      WHERE action = 'export.read'
    `) as { action: string; actor_id: string; subject_type: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(created.token.id);
    expect(audit[0].subject_type).toBe("export_token");
  });

  test("returns 429 once the per-IP export limit is exceeded", async () => {
    const created = await createToken("laptop");

    for (let i = 0; i < EXPORT_RATE_LIMIT; i++) {
      const response = await exportApi.index(get(`Bearer ${created.rawToken}`));
      expect(response.status).toBe(200);
    }

    const blocked = await exportApi.index(get(`Bearer ${created.rawToken}`));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
  });
});
