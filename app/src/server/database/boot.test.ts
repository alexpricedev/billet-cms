import { afterAll, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import {
  createSiteTables,
  createTempDatabase,
  relationNames,
} from "../test-utils/migration-helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { CONTRACT_VERSION } from "@alexpricedev/billet-cms/contract";
import { handleFallback } from "../utils/fallback";
import { ensureIdentitiesView } from "./identity-view";
import { runMigrations } from "./migrate";

const SITE_RELATIONS = ["migrations", "sessions", "user_tokens", "users"];

describe("a CMS boot against a site database", () => {
  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  test("creates only cms_ relations and writes the contract version", async () => {
    const temp = await createTempDatabase("boot");

    try {
      const sql = temp.open();
      await createSiteTables(sql);

      await runMigrations(sql);
      await ensureIdentitiesView(sql);

      const relations = await relationNames(sql);
      const foreign = relations.filter(
        (name) => !name.startsWith("cms_") && !SITE_RELATIONS.includes(name),
      );
      expect(foreign).toEqual([]);
      expect(relations).toContain("cms_identities");

      const meta = await sql`
        SELECT contract_version, content_version FROM cms_meta WHERE id = 1
      `;
      const row = meta[0] as {
        contract_version: string;
        content_version: string;
      };
      expect(row.contract_version).toBe(CONTRACT_VERSION);
      // The site bumps this on publish; the CMS only seeds the row.
      expect(Number(row.content_version)).toBe(1);
    } finally {
      await temp.drop();
    }
  });
});

describe("/health", () => {
  afterAll(() => {
    mock.restore();
  });

  test("answers 200 without touching the database", async () => {
    const response = await handleFallback(
      new Request("http://localhost/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
