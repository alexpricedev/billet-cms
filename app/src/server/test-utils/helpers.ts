import { expect } from "bun:test";
import type { SQL } from "bun";

/**
 * Clean up test data between tests.
 *
 * Truncates every table the CMS owns — and only those. The CMS shares a
 * database with the site it serves in production, so a blanket truncate here
 * would wipe the site's own tables in any test that points at one.
 */
export const cleanupTestData = async (db: SQL): Promise<void> => {
  await db`
    TRUNCATE TABLE
      cms_user_tokens, cms_sessions, cms_users,
      cms_block_types, cms_page_types, cms_slots
    RESTART IDENTITY CASCADE
  `;
};

/**
 * Generate a random email address for testing.
 */
export const randomEmail = (domain = "example.com"): string => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `test-${timestamp}-${random}@${domain}`;
};

/**
 * Assert that a query fails — a constraint, a CHECK, a permission.
 *
 * `expect(db`…`).rejects` does not work here and does not fail either: a
 * Bun.SQL tagged template is a lazy thenable rather than a Promise, so
 * `.rejects` never settles and the file times out with no failing assertion to
 * point at. Awaiting it inside a real async function is what gives Bun a
 * promise to reject.
 */
export const expectQueryToReject = async (
  run: () => unknown,
  expected?: string | RegExp,
): Promise<void> => {
  const settled = (async () => {
    await run();
  })();
  await (expected === undefined
    ? expect(settled).rejects.toThrow()
    : expect(settled).rejects.toThrow(expected));
};

/**
 * Runs `body` with the site-wide indexing switch open.
 *
 * Indexing is closed unless `ALLOW_INDEXING=true`, and the closed default
 * renders `noindex` on every page by itself, so a test about a page's *own*
 * `noindex` prop has to open the switch first.
 */
export const withIndexingAllowed = async <T>(
  body: () => T | Promise<T>,
): Promise<T> => {
  const previous = process.env.ALLOW_INDEXING;
  process.env.ALLOW_INDEXING = "true";
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.ALLOW_INDEXING;
    } else {
      process.env.ALLOW_INDEXING = previous;
    }
  }
};
