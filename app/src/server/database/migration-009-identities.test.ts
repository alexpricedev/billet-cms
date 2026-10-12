import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createSiteTables,
  createTempDatabase,
} from "../test-utils/migration-helpers";
import { runMigrations } from "./migrate";
import { down, up } from "./migrations/009_identities_and_handoff";

/**
 * Rolling migration 009 back has to cope with what the rollback's foreign keys
 * would otherwise reject: sessions and tokens written while the columns named
 * identities from the site's `users`, against an empty recreated `cms_users`.
 */
describe("009_identities_and_handoff down()", () => {
  // A temp database and a full migration run; well over the 5s default on a
  // slow machine, the same as the other migration tests.
  test("re-adds the foreign keys despite existing sessions and tokens", async () => {
    const temp = await createTempDatabase("migration-009-down");

    try {
      const sql = temp.open();
      await createSiteTables(sql);
      await runMigrations(sql);

      const identityId = randomUUID();
      await sql`
        INSERT INTO cms_sessions (id_hash, user_id, session_type, expires_at)
        VALUES
          ('auth-hash', ${identityId}, 'authenticated', NOW() + INTERVAL '1 day'),
          ('guest-hash', NULL, 'guest', NOW() + INTERVAL '1 day')
      `;
      await sql`
        INSERT INTO cms_user_tokens (user_id, token_hash, type, expires_at)
        VALUES (${identityId}, 'token-hash', 'magic_link', NOW() + INTERVAL '1 day')
      `;

      await down(sql);

      const constraints = await sql`
        SELECT conname FROM pg_constraint
        WHERE conname IN (
          'cms_sessions_user_id_fkey',
          'cms_user_tokens_user_id_fkey'
        )
      `;
      expect(constraints.length).toBe(2);

      // Rows naming an identity are gone; the guest session is not.
      const sessions = await sql`SELECT id_hash FROM cms_sessions`;
      expect(sessions).toEqual([{ id_hash: "guest-hash" }]);
      const tokens = await sql`SELECT id FROM cms_user_tokens`;
      expect(tokens).toEqual([]);

      // And it rolls forward again: `cms_users` is gone, handoff tokens are back.
      await up(sql);
      const users = await sql`SELECT to_regclass('cms_users') AS relation`;
      expect(users[0].relation).toBeNull();
      const handoff =
        await sql`SELECT to_regclass('cms_handoff_tokens') AS relation`;
      expect(handoff[0].relation).not.toBeNull();
    } finally {
      await temp.drop();
    }
  }, 60000);
});
