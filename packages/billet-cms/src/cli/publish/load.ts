/**
 * Load a site's `cms.config.ts`.
 *
 * A site declares its definitions in its own repo; the CMS never imports site
 * code. This is the one place the site's config crosses into the plugin, and it
 * is deliberately narrow: three named arrays, or a default export holding them.
 */
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SiteDefinitions } from "./publish";

/** The config file couldn't be imported. */
export class DefinitionsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionsLoadError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const loadDefinitions = async (
  configPath: string,
): Promise<SiteDefinitions> => {
  const absolute = isAbsolute(configPath)
    ? configPath
    : resolve(process.cwd(), configPath);

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(absolute).href)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DefinitionsLoadError(
      `Could not load the CMS config at ${absolute}: ${reason}`,
    );
  }

  // A config may export the arrays by name, or hold them on a default export.
  const fallback = isRecord(module.default) ? module.default : {};
  const pick = (key: string): unknown => module[key] ?? fallback[key];

  return {
    blocks: pick("blocks") as SiteDefinitions["blocks"],
    pageTypes: pick("pageTypes") as SiteDefinitions["pageTypes"],
    slots: pick("slots") as SiteDefinitions["slots"],
  };
};
