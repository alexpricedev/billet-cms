import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { testDatabase } from "../test-utils/database";
import { cleanupTestData, seedIdentity } from "../test-utils/helpers";

const connection = testDatabase();

mock.module("./database", () => ({
  get db() {
    return connection;
  },
}));

import { db } from "./database";
import {
  DEFAULT_THEME,
  getTheme,
  parseTheme,
  setTheme,
  THEMES,
} from "./preferences";

describe("Preferences Service", () => {
  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await connection.end();
    mock.restore();
  });

  describe("parseTheme", () => {
    test("returns each known theme unchanged", () => {
      for (const theme of THEMES) {
        expect(parseTheme(theme)).toBe(theme);
      }
    });

    test("reads an unknown value as system", () => {
      expect(DEFAULT_THEME).toBe("system");
      expect(parseTheme("neon")).toBe("system");
      expect(parseTheme("DARK")).toBe("system");
      expect(parseTheme(undefined)).toBe("system");
      expect(parseTheme(null)).toBe("system");
    });
  });

  describe("getTheme", () => {
    test("reads system when the editor has no row", async () => {
      const user = await seedIdentity(db, "no-prefs@example.com");

      expect(await getTheme(user.id)).toBe("system");
    });
  });

  describe("setTheme", () => {
    test("saves each theme and reads it back", async () => {
      const user = await seedIdentity(db, "prefs@example.com");

      for (const theme of THEMES) {
        expect(await setTheme(user.id, theme)).toBe(theme);
        expect(await getTheme(user.id)).toBe(theme);
      }
    });

    test("updates the one row on a second save", async () => {
      const user = await seedIdentity(db, "twice@example.com");

      await setTheme(user.id, "dark");
      await setTheme(user.id, "light");

      const rows = (await db`
        SELECT user_id, theme FROM cms_user_preferences
      `) as { user_id: string; theme: string }[];
      expect(rows).toEqual([{ user_id: user.id, theme: "light" }]);
    });

    test("refuses an unknown theme and writes nothing", async () => {
      const user = await seedIdentity(db, "bad@example.com");

      expect(await setTheme(user.id, "neon")).toBeNull();

      const rows = await db`SELECT theme FROM cms_user_preferences`;
      expect(rows).toEqual([]);
      expect(await getTheme(user.id)).toBe("system");
    });

    test("a refusal leaves an existing choice alone", async () => {
      const user = await seedIdentity(db, "kept@example.com");
      await setTheme(user.id, "dark");

      expect(await setTheme(user.id, "sepia")).toBeNull();

      expect(await getTheme(user.id)).toBe("dark");
    });
  });
});
