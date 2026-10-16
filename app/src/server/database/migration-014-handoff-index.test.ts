import { describe, expect, test } from "bun:test";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/014_drop_handoff_user_index";

/**
 * 014 removes an index 009 created but no query uses: the handoff token is
 * claimed by `token_hash` and swept by `expires_at`, never looked up by user.
 */
describe("014_drop_handoff_user_index", () => {
  test("drops the unused user index, keeps the expiry one, and is reversible", async () => {
    const temp = await createTempDatabase("migration-014");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const hasIndex = async (name: string): Promise<boolean> => {
        const rows = await sql`SELECT to_regclass(${name}) AS relation`;
        return (rows[0] as { relation: string | null }).relation !== null;
      };

      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(false);
      // The cleanup sweep filters on `expires_at`, so that index stays.
      expect(await hasIndex("cms_handoff_tokens_expires_at_idx")).toBe(true);

      await down(sql);
      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(true);
      await up(sql);
      expect(await hasIndex("cms_handoff_tokens_user_id_idx")).toBe(false);
    } finally {
      await temp.drop();
    }
  }, 60000);
});
