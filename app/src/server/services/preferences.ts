import { TABLES } from "@alexpricedev/billet-cms/contract";
import { db } from "./database";

/**
 * The themes the account page offers.
 *
 * `system` — follow the operating system's light or dark setting — is the
 * default, and what an editor who has never chosen gets. It is also what an
 * unrecognised stored value reads as.
 */
export const THEMES = ["light", "dark", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "system";

export const isTheme = (value: unknown): value is Theme =>
  typeof value === "string" && (THEMES as readonly string[]).includes(value);

/** The theme a stored or submitted value means; anything else is `system`. */
export const parseTheme = (value: unknown): Theme =>
  isTheme(value) ? value : DEFAULT_THEME;

interface ThemeRow {
  theme: string;
}

/**
 * Read the theme an editor chose, or `system` when they have not chosen one.
 *
 * A missing row means they never saved, and an unknown value reads as `system`
 * too: the CHECK refuses one from the CMS, but a hand-edited row — or a theme
 * from a newer build — must not stop the page rendering.
 */
export const getTheme = async (userId: string): Promise<Theme> => {
  const rows = (await db`
    SELECT theme
    FROM ${db(TABLES.userPreferences)}
    WHERE user_id = ${userId}
  `) as ThemeRow[];

  return rows.length > 0 ? parseTheme(rows[0].theme) : DEFAULT_THEME;
};

/**
 * Save an editor's theme, creating their preferences row on first save.
 *
 * Returns the theme stored, or `null` when the value is not one of `THEMES` —
 * refused before the write, so a bad form post changes nothing and the CHECK
 * never sees it.
 */
export const setTheme = async (
  userId: string,
  theme: string,
): Promise<Theme | null> => {
  if (!isTheme(theme)) return null;

  await db`
    INSERT INTO ${db(TABLES.userPreferences)} (user_id, theme)
    VALUES (${userId}, ${theme})
    ON CONFLICT (user_id) DO UPDATE
      SET theme = EXCLUDED.theme,
          updated_at = CURRENT_TIMESTAMP
  `;

  return theme;
};
