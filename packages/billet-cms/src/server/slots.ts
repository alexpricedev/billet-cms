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
 * at most once a second (Q3, `./cache.ts`), one poll shared with the page and
 * media readers, so a publish is visible on the site within seconds and the
 * steady state costs no queries. A valid preview token
 * (`./preview`, Phase 6) bypasses that cache for its own subject only: pass the
 * access `getPreviewAccess` returned to `getSlot` and the slot the token names
 * has its draft read instead, uncached, while every other slot on the page is
 * still served from the cache.
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
import type { PreviewAccess } from "../preview";
import { validateContent } from "../schema";
import { ContentCache, readerCacheOptions } from "./cache";
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
  /**
   * Where skipped content is reported. Defaults to the console.
   *
   * It does not receive `content_version` poll failures: the poll is shared
   * between every reader on the pool, so it logs through the default logger
   * rather than any one reader's sink. A reader built with an injected `now`
   * gets a private poll and does report through this logger.
   */
  onSkip?: SkipLogger;
}

/**
 * A site's own block definition, passed to `getSlot` to check the stored
 * content against the code, not just the JSON Schema published from it.
 */
export interface SlotReadOptions {
  block?: BlockDefinitionShape;
  /**
   * The preview access the request carried, from `getPreviewAccess`, or `null`
   * for a published read. When the token's subject is this slot, the newest
   * draft is read instead of the published revision, and the read bypasses the
   * content-version cache for this slot only — every other slot still reads
   * from it. `null` is accepted so a site can forward the access the catch-all
   * handed its render function without branching.
   */
  preview?: PreviewAccess | null;
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
  /**
   * A hard reset: drop every cached entry and re-read `content_version` on the
   * next read.
   */
  invalidate(): void;
}

interface SlotRow {
  id: string;
  name: string;
  block_name: string;
  removed_at: Date | null;
  published_revision_id: string | null;
}

/**
 * The slot row joined to its block type and its published revision, in one
 * read.
 *
 * The two `LEFT JOIN`s are what turn the three sequential queries a cold slot
 * used to cost (slot, block type, revision) into one; a missing block or
 * revision arrives as a null column rather than a second round trip. The `*_found`
 * columns are the join's own existence checks, so a null `content` is
 * distinguishable from a null `json_schema` without re-reading either table.
 */
interface JoinedSlotRow extends SlotRow {
  block_found: string | null;
  json_schema: Record<string, unknown> | null;
  block_removed_at: Date | null;
  revision_found: string | null;
  content: Record<string, unknown> | null;
}

/**
 * The joined slot row plus the slot's newest revision, in one read.
 *
 * `latest_revision_id`/`latest_content` come from a `LEFT JOIN LATERAL`, so a
 * preview gets the draft it must render without the two extra round trips
 * (newest-revision id, then that revision's content) a cold preview used to pay.
 * The lateral's `ORDER BY` is the same one `latestRevisionId` uses, so the
 * preview reads and the standalone helper cannot drift on which revision is
 * newest.
 */
interface PreviewSlotRow extends JoinedSlotRow {
  latest_revision_id: string | null;
  latest_content: Record<string, unknown> | null;
}

/**
 * The value the slot cache holds: the published content plus the row id, so a
 * preview can tell whether a token names this slot. `null` (no cache entry at
 * all) means the slot isn't declared.
 */
interface CachedSlot {
  slotId: string;
  content: SlotContent | null;
}

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

  /**
   * The slot row, its block type and its published revision, in one query.
   *
   * The joins are what a cold slot used to pay three round trips for. The row
   * still lets each skip below name the same problem it always did, from the
   * joined columns rather than a second read.
   */
  const readSlotRow = async (name: string): Promise<JoinedSlotRow | null> => {
    const slots = (await sql.unsafe(
      `SELECT s.id, s.name, s.block_name, s.removed_at, s.published_revision_id,
              b.name AS block_found, b.json_schema,
              b.removed_at AS block_removed_at,
              r.id AS revision_found, r.content
       FROM ${TABLES.slots} s
       LEFT JOIN ${TABLES.blockTypes} b ON b.name = s.block_name
       LEFT JOIN ${TABLES.revisions} r ON r.id = s.published_revision_id
       WHERE s.name = $1`,
      [name],
    )) as JoinedSlotRow[];
    return slots[0] ?? null;
  };

  /**
   * The slot row, its block type, its published revision and its newest
   * revision, in one read.
   *
   * A preview must reflect the editor's latest save, which the published row
   * does not carry, so the newest revision is joined in with a `LEFT JOIN
   * LATERAL` rather than read by a second query. The lateral's ordering matches
   * `latestRevisionId` exactly (`created_at DESC, id DESC`), so the two agree
   * on which revision is newest, and a slot with no revision arrives as null
   * columns rather than a second round trip.
   */
  const readPreviewSlotRow = async (
    name: string,
  ): Promise<PreviewSlotRow | null> => {
    const slots = (await sql.unsafe(
      `SELECT s.id, s.name, s.block_name, s.removed_at, s.published_revision_id,
              b.name AS block_found, b.json_schema,
              b.removed_at AS block_removed_at,
              r.id AS revision_found, r.content,
              latest.id AS latest_revision_id, latest.content AS latest_content
       FROM ${TABLES.slots} s
       LEFT JOIN ${TABLES.blockTypes} b ON b.name = s.block_name
       LEFT JOIN ${TABLES.revisions} r ON r.id = s.published_revision_id
       LEFT JOIN LATERAL (
         SELECT id, content FROM ${TABLES.revisions}
         WHERE target_type = 'slot' AND target_id = s.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest ON true
       WHERE s.name = $1`,
      [name],
    )) as PreviewSlotRow[];
    return slots[0] ?? null;
  };

  const loadSlot = async (name: string): Promise<CachedSlot | null> => {
    const slot = await readSlotRow(name);
    if (!slot) return null;
    if (slot.removed_at !== null) {
      onSkip(`slot "${name}" is no longer declared in the site's templates`);
      return null;
    }

    // Never published: nothing to render, and nothing wrong.
    if (!slot.published_revision_id) {
      return { slotId: slot.id, content: null };
    }
    return {
      slotId: slot.id,
      content: readSlotRevision(slot, slot.content),
    };
  };

  /**
   * Read the draft when the preview token's subject is this slot.
   *
   * The joined row carries the block type, the published revision and the
   * newest revision in one query, so a preview adds one read on top of the
   * cached lookup that found the slot: `getSlot` first calls `cache.get(name)`
   * to learn the slot id, which is one `loadSlot` query when the cache is cold,
   * and then this joined read runs. A cold preview therefore costs two slot
   * queries, a warm one a single joined read, and neither runs a separate
   * `cms_revisions` query. The newest revision wins unless it is the published
   * one, in which case the published content already in the row is reused.
   */
  const loadPreviewSlot = async (name: string): Promise<SlotContent | null> => {
    const slot = await readPreviewSlotRow(name);
    if (!slot) return null;
    if (slot.removed_at !== null) {
      onSkip(`slot "${name}" is no longer declared in the site's templates`);
      return null;
    }

    const revisionId = slot.latest_revision_id;
    if (!revisionId) return null;
    // Reuse the joined content when the newest revision is also the published
    // one, rather than reading the same row twice.
    const content =
      revisionId === slot.published_revision_id
        ? slot.content
        : slot.latest_content;
    return readSlotRevision(slot, content);
  };

  /**
   * Validate one stored revision against the block type's published contract.
   *
   * Pure over the joined row and the revision's content: the block-type checks
   * and the validation the published and preview reads share happen here, with
   * the same skip messages and in the same order for both.
   */
  const readSlotRevision = (
    slot: JoinedSlotRow,
    content: Record<string, unknown> | null,
  ): SlotContent | null => {
    if (!slot.block_found) {
      onSkip(
        `slot "${slot.name}" uses block "${slot.block_name}", which is not published`,
      );
      return null;
    }
    if (slot.block_removed_at !== null) {
      onSkip(
        `slot "${slot.name}" uses block "${slot.block_name}", which was removed by a deploy`,
      );
      return null;
    }
    if (content === null) {
      onSkip(`slot "${slot.name}" points at a revision that no longer exists`);
      return null;
    }

    // Removed top-level fields are tolerated (Q4): the CMS keeps them and the
    // read side must not fail a whole slot over a key nobody renders. Anything
    // genuinely invalid — a missing required field, a wrong type — is skipped.
    const validation = validateContent(slot.json_schema ?? {}, content, {
      allowAdditionalFields: true,
    });
    if (!validation.success) {
      const detail = validation.issues
        .map(
          (issue) => `${issue.path.join(".") || "(content)"}: ${issue.message}`,
        )
        .join("; ");
      onSkip(`slot "${slot.name}" content no longer validates — ${detail}`);
      return null;
    }

    return validation.data as SlotContent;
  };

  const cache = new ContentCache<CachedSlot | null>({
    // One poll for the whole pool: the page and media readers share it, so a
    // process asks `cms_meta` once a second, not once per reader. A failed
    // version check keeps serving what is cached (see `ContentCache`); the
    // shared poll logs it through the default logger, not this reader's
    // `onSkip` (see `readerCacheOptions`).
    ...readerCacheOptions(sql, options, onSkip),
    load: loadSlot,
  });

  return {
    async getSlot<T = SlotContent>(
      name: string,
      options?: SlotReadOptions,
    ): Promise<T | null> {
      try {
        // A preview bypasses the cache only for the token's own subject: the
        // draft must not be served from, or written to, the published cache,
        // and must reflect the newest save. Every other slot on the page reads
        // the published value from the cache, so previewing one slot does not
        // pay an uncached read for the whole page.
        const preview = options?.preview;
        let content: SlotContent | null;
        if (preview?.subjectType === "slot") {
          const cached = await cache.get(name);
          content =
            cached && cached.slotId === preview.subjectId
              ? await loadPreviewSlot(name)
              : (cached?.content ?? null);
        } else {
          // No preview, or a page's token: every slot reads as published.
          content = (await cache.get(name))?.content ?? null;
        }
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
 *
 * Pass `{ preview }` with the access `getPreviewAccess` returned — or the
 * `null` the catch-all hands a render function — to read the draft a token
 * covers, uncached. Only the token's own slot leaves the cache; any other slot
 * still reads as published. `null` is the published read.
 */
export function getSlot<T = SlotContent>(
  sql: SQL,
  name: string,
): Promise<T | null>;
export function getSlot<F extends BlockFields>(
  sql: SQL,
  name: string,
  options: { block: BlockDefinition<F>; preview?: PreviewAccess | null },
): Promise<BlockContent<F> | null>;
export function getSlot(
  sql: SQL,
  name: string,
  options: SlotReadOptions,
): Promise<SlotContent | null>;
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
