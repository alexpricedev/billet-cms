/* biome-ignore-all lint/suspicious/noConsole: the plugin's fallback logger */

/**
 * Where a read helper reports content it skipped.
 *
 * A site's page must keep rendering when a slot's stored content no longer
 * validates, the block behind it was removed, or the CMS's tables aren't there
 * at all: the helper logs what it dropped and returns nothing rather than
 * letting a bad row 500 the page. The default writes to the console; a site can
 * pass its own sink.
 */
export type SkipLogger = (message: string) => void;

export const defaultSkipLogger: SkipLogger = (message) => {
  console.warn(`[billet-cms] ${message}`);
};
