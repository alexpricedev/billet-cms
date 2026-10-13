/**
 * Reading published content from the `cms_` tables, for the site.
 *
 * The site renders its own pages; the CMS is never on the request path. A
 * template asks this reader for the content of a slot it declared, hands the
 * result to that block's render function, and gets back either the validated
 * content or nothing. Two rules make that safe to do on a live page:
 *
 * 1. **The database is the runtime contract.** The reader validates the stored
 *    revision against the block's published JSON Schema before returning it, so
 *    a render function is only ever handed content its own vocabulary accepts.
 *    Pass `{ block }` to `getSlot` and it is checked against the site's own Zod
 *    schema too, so a block whose code has moved past what was published is a
 *    skip rather than content the render function never expected.
 * 2. **A bad row is skipped, never a 500.** A removed slot or block, a revision
 *    that no longer validates, a missing CMS table or an unreachable database
 *    all log a line and return `null`. A page that has lost one slot's content
 *    still renders the rest of itself (the spec's "the site keeps working").
 *
 * Reads are cached in memory and re-checked against `cms_meta.content_version`
 * at most once a second (Q3, `./cache.ts`), so a publish is visible on the site
 * within seconds and the steady state costs no queries.
 */
import type { SQL } from "bun";
import { TABLES } from "../contract";
import {
  type BlockContent,
  type BlockDefinition,
  type BlockDefinitionShape,
  type BlockFields,
  blockContentReadSchema,
} from "../fields/definition";
import { validateContent } from "../schema";
import { ContentCache } from "./cache";
import { defaultSkipLogger, type SkipLogger } from "./log";

/** The validated content of one published slot, keyed by field/block name. */
export type SlotContent = Record<string, unknown>;

export interface ContentReaderOptions {
  /** The site's pool, shared with its own Billet tables. */
  sql: SQL;
  /** Injected clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often `content_version` is re-read. Defaults to one second (Q3). */
  versionPollMs?: number;
  /** Where skipped content is reported. Defaults to the console. */
  onSkip?: SkipLogger;
}

/**
 * A site's own block definition, passed to `getSlot` to check the stored
 * content against the code, not just the JSON Schema published from it.
 */
export interface SlotReadOptions {
  block: BlockDefinitionShape;
}

export interface ContentReader {
  /**
   * The published content of `name`, or `null` when there is none to render.
   *
   * Pass `{ block }` to parse the row against the site's own block definition
   * as well, so content its render function was not written for is skipped. The
   * top-level `getSlot` infers the content type from the definition.
   */
  getSlot<T = SlotContent>(
    name: string,
    options?: SlotReadOptions,
  ): Promise<T | null>;
  /** Drop the cache and force the next read to re-check `content_version`. */
  invalidate(): void;
}

interface SlotRow {
  id: string;
  block_name: string;
  removed_at: Date | null;
  published_revision_id: string | null;
}

interface BlockTypeRow {
  json_schema: Record<string, unknown>;
  removed_at: Date | null;
}

interface RevisionRow {
  content: Record<string, unknown>;
}

const readContentVersion = async (sql: SQL): Promise<number> => {
  const rows = (await sql.unsafe(
    `SELECT content_version FROM ${TABLES.meta} WHERE id = 1`,
  )) as { content_version: string | number }[];
  return rows.length > 0 ? Number(rows[0].content_version) : 0;
};

/**
 * Build a reader that caches per process.
 *
 * One reader per pool: the cache has to be shared between the requests of a
 * process to be worth having, so a site creates it once at module load rather
 * than per request. `getSlot` below is the convenience for that.
 */
export const createContentReader = (
  options: ContentReaderOptions,
): ContentReader => {
  const { sql } = options;
  const onSkip = options.onSkip ?? defaultSkipLogger;

  const loadSlot = async (name: string): Promise<SlotContent | null> => {
    const slots = (await sql.unsafe(
      `SELECT id, block_name, removed_at, published_revision_id
       FROM ${TABLES.slots} WHERE name = $1`,
      [name],
    )) as SlotRow[];

    const slot = slots[0];
    if (!slot) return null;
    if (slot.removed_at !== null) {
      onSkip(`slot "${name}" is no longer declared in the site's templates`);
      return null;
    }

    // Never published: nothing to render, and nothing wrong.
    if (!slot.published_revision_id) return null;

    const blockTypes = (await sql.unsafe(
      `SELECT json_schema, removed_at FROM ${TABLES.blockTypes} WHERE name = $1`,
      [slot.block_name],
    )) as BlockTypeRow[];

    const blockType = blockTypes[0];
    if (!blockType) {
      onSkip(
        `slot "${name}" uses block "${slot.block_name}", which is not published`,
      );
      return null;
    }
    if (blockType.removed_at !== null) {
      onSkip(
        `slot "${name}" uses block "${slot.block_name}", which was removed by a deploy`,
      );
      return null;
    }

    const revisions = (await sql.unsafe(
      `SELECT content FROM ${TABLES.revisions} WHERE id = $1`,
      [slot.published_revision_id],
    )) as RevisionRow[];

    const revision = revisions[0];
    if (!revision) {
      onSkip(
        `slot "${name}" points at a published revision that no longer exists`,
      );
      return null;
    }

    // Removed top-level fields are tolerated (Q4): the CMS keeps them and the
    // read side must not fail a whole slot over a key nobody renders. Anything
    // genuinely invalid — a missing required field, a wrong type — is skipped.
    const validation = validateContent(
      blockType.json_schema,
      revision.content,
      {
        allowAdditionalFields: true,
      },
    );
    if (!validation.success) {
      const detail = validation.issues
        .map(
          (issue) => `${issue.path.join(".") || "(content)"}: ${issue.message}`,
        )
        .join("; ");
      onSkip(`slot "${name}" content no longer validates — ${detail}`);
      return null;
    }

    return validation.data as SlotContent;
  };

  const cache = new ContentCache<SlotContent | null>({
    readVersion: () => readContentVersion(sql),
    load: loadSlot,
    // A failed version check keeps serving what is cached (see `ContentCache`);
    // the site hears about it through its skip logger like any other drop.
    onVersionError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      onSkip(`could not check the CMS content version: ${message}`);
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.versionPollMs !== undefined
      ? { intervalMs: options.versionPollMs }
      : {}),
  });

  return {
    async getSlot<T = SlotContent>(
      name: string,
      options?: SlotReadOptions,
    ): Promise<T | null> {
      try {
        const content = await cache.get(name);
        if (content === null) return null;

        // The stored schema is the published contract; the site's own block
        // schema is what its render function was actually written for. Running
        // it too catches the case the stored schema can't: a deploy changed a
        // field's type, so the content is valid by the old contract but not by
        // the code that would render it. Invalid content is skipped and
        // reported, exactly like a row the stored schema has already rejected.
        if (options?.block) {
          // `blockContentReadSchema`, not the strict published one: a field the
          // block has dropped is still in the stored content (Q4) and must not
          // turn a read into a skip. Unknown keys are stripped; a field whose
          // type changed still fails.
          const parsed = blockContentReadSchema(options.block).safeParse(
            content,
          );
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "(content)"}: ${issue.message}`,
              )
              .join("; ");
            onSkip(
              `slot "${name}" content failed the block's own schema — ${detail}`,
            );
            return null;
          }
          return parsed.data as T;
        }

        return content as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onSkip(`could not read slot "${name}": ${message}`);
        return null;
      }
    },

    invalidate(): void {
      cache.invalidate();
    },
  };
};

/**
 * Readers, one per pool.
 *
 * A `WeakMap` keyed by the pool keeps a site's single long-lived pool and its
 * single cache together, while a test that makes a fresh pool each case gets a
 * fresh cache rather than inheriting a previous case's version.
 */
const readers = new WeakMap<SQL, ContentReader>();

const readerFor = (sql: SQL): ContentReader => {
  const existing = readers.get(sql);
  if (existing) return existing;

  const reader = createContentReader({ sql });
  readers.set(sql, reader);
  return reader;
};

/**
 * Read a published slot using a process-wide reader for `sql`.
 *
 * For a site that would rather not hold a reader itself. A caller that needs to
 * inject a clock (tests) or a logger should build one with
 * `createContentReader`.
 *
 * Pass the site's own `block` to have the content parsed against its Zod
 * schema too; the result is typed from that definition, so a render function
 * gets the content its own fields declare.
 */
export function getSlot<T = SlotContent>(
  sql: SQL,
  name: string,
): Promise<T | null>;
export function getSlot<F extends BlockFields>(
  sql: SQL,
  name: string,
  options: { block: BlockDefinition<F> },
): Promise<BlockContent<F> | null>;
export function getSlot(
  sql: SQL,
  name: string,
  options?: SlotReadOptions,
): Promise<SlotContent | null> {
  const reader = readerFor(sql);
  return options
    ? reader.getSlot<SlotContent>(name, options)
    : reader.getSlot<SlotContent>(name);
}
