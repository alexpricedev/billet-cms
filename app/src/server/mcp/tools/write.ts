/**
 * The write half of the MCP tool suite.
 *
 * Every tool delegates to the same write layer the CMS forms use
 * (`saveSlotDraft`, `savePage`, `publishSlot`, `publishPage`). That is what
 * makes an agent's save subject to the same schema, image guidance, row lock,
 * stale-revision check and `content_version` bump as an editor's — and why a
 * refusal reads the same to both.
 *
 * Nothing here is destructive beyond publishing: a bad publish is undone by
 * publishing an older revision, and a draft never reaches the site.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  asPageContent,
  type BlockTypeRecord,
  blockContentIssues,
  type FieldIssue,
  getBlockTypeByName,
  getLatestRevision,
  getPageById,
  getPageByUrl,
  getPageTypeByName,
  getSlotById,
  getSlotByName,
  listBlockTypes,
  type PageBlock,
  type PageRecord,
  publishPage,
  publishSlot,
  type SlotRecord,
  savePage,
  saveSlotDraft,
  validatePageContent,
} from "../../services/content";
import { checkImageGuidance, type ImageGuidance } from "../../services/media";
import type { McpActor } from "../auth";
import {
  errorResult,
  guard,
  issuesResult,
  okResult,
  UUID_PATTERN,
} from "../results";

const findSlot = async (handle: string): Promise<SlotRecord | null> =>
  (await getSlotByName(handle)) ??
  (UUID_PATTERN.test(handle) ? await getSlotById(handle) : null);

const findPage = async (input: {
  id?: string;
  url?: string;
}): Promise<PageRecord | null> => {
  if (input.id) return getPageById(input.id);
  if (input.url) return getPageByUrl(input.url);
  return null;
};

const blockTypesByName = async (): Promise<Map<string, BlockTypeRecord>> =>
  new Map((await listBlockTypes()).map((block) => [block.name, block]));

/**
 * The field-level findings a page's image references have, by block index.
 *
 * The two are kept apart for the same reason the write layer keeps them apart:
 * an `aspect` mismatch refuses the save, a narrow image only warns, so a
 * validate result can say which is which rather than making the model choose
 * another picture for a save that would have gone through.
 */
const pageImageGuidance = async (
  blockTypes: Map<string, BlockTypeRecord>,
  blocks: PageBlock[],
): Promise<ImageGuidance> => {
  const issues: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  for (const [index, block] of blocks.entries()) {
    const blockType = blockTypes.get(block.type);
    if (!blockType) continue;
    const { type: _type, ...fields } = block;
    const guidance = await checkImageGuidance(blockType.fields, fields);
    for (const issue of guidance.issues) {
      issues.push({
        path: `blocks.${index}.${issue.path}`,
        message: issue.message,
      });
    }
    for (const warning of guidance.warnings) {
      warnings.push({
        path: `blocks.${index}.${warning.path}`,
        message: warning.message,
      });
    }
  }
  return { issues, warnings };
};

const summarizePage = (page: PageRecord) => ({
  id: page.id,
  url: page.url,
  /** An address change waiting for Publish, when one is saved. */
  draftUrl: page.draftUrl,
  title: page.title,
  pageType: page.pageType,
});

/**
 * The largest serialised content one write may carry.
 *
 * The request body cap is 20 MB because a media upload shares it; content is
 * text and a megabyte is already far past any real block. Checking here keeps a
 * single call from writing an unreadable revision, and keeps the audit table's
 * target fields meaningful.
 */
const MAX_CONTENT_BYTES = 1024 * 1024;
const TOO_LARGE_MESSAGE =
  "This content is larger than 1 MB. Shorten it and try again.";

const tooLarge = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTENT_BYTES;

const tooLargeResult = () =>
  issuesResult(TOO_LARGE_MESSAGE, "invalid", {
    issues: [{ path: "(content)", message: TOO_LARGE_MESSAGE }],
  });

/**
 * A successful write's payload, with any warnings beside it.
 *
 * A narrow image does not refuse a save or a publish (see
 * `services/media/guidance`), so the only place a caller hears about it is
 * here, on the result that went through — the same way the editor's banner
 * names it after the redirect.
 */
const written = (
  value: Record<string, unknown>,
  warnings: readonly FieldIssue[],
): Record<string, unknown> =>
  warnings.length > 0 ? { ...value, warnings } : value;

export const registerWriteTools = (
  server: McpServer,
  actor: McpActor | null,
): void => {
  const actorId = actor?.id ?? null;

  server.registerTool(
    "validate_slot",
    {
      title: "Validate slot content",
      description:
        "Check slot content against the block's schema and image guidance without saving a revision. Use it while iterating, then save_slot once.",
      inputSchema: z.object({
        slot: z.string().min(1).describe("Slot name, e.g. home.hero."),
        content: z.record(z.string(), z.unknown()),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ slot: handle, content }) =>
      guard("validate_slot", async () => {
        if (tooLarge(content)) return tooLargeResult();
        const slot = await findSlot(handle);
        if (!slot) {
          return errorResult(`No slot named "${handle}".`, {
            reason: "not-found",
          });
        }
        const blockType = await getBlockTypeByName(slot.blockName);
        if (!blockType) {
          return errorResult(`Block "${slot.blockName}" is not published.`, {
            reason: "not-found",
          });
        }

        // Button text is an editor rule, not a schema one; the shared helper
        // runs both so validate_slot cannot say the content is fine and
        // save_slot then refuse it.
        const issues = blockContentIssues(blockType, content);
        if (issues.length > 0) {
          return issuesResult(
            `The content does not validate: ${issues.length} issue(s).`,
            "invalid",
            { issues },
          );
        }

        const guidance = await checkImageGuidance(blockType.fields, content);
        if (guidance.issues.length > 0) {
          return issuesResult(
            `The images do not meet the block's guidance: ${guidance.issues.length} issue(s).`,
            "invalid",
            { issues: guidance.issues },
          );
        }

        return okResult({
          ok: true,
          slot: slot.name,
          ...(guidance.warnings.length > 0
            ? { warnings: guidance.warnings }
            : {}),
        });
      }),
  );

  server.registerTool(
    "validate_page",
    {
      title: "Validate page blocks",
      description:
        "Check a page's blocks against its page type and every block schema without saving a revision.",
      inputSchema: z.object({
        id: z.string().optional(),
        url: z.string().optional(),
        blocks: z.array(z.looseObject({ type: z.string() })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, url, blocks }) =>
      guard("validate_page", async () => {
        if (tooLarge({ blocks })) return tooLargeResult();
        if (!id && !url) {
          return errorResult("Pass either id or url.", { reason: "invalid" });
        }
        const page = await findPage({ id, url });
        if (!page) {
          return errorResult(`No page for ${id ?? url}.`, {
            reason: "not-found",
          });
        }
        const pageType = await getPageTypeByName(page.pageType);
        if (!pageType) {
          return errorResult(`Page type "${page.pageType}" is not published.`, {
            reason: "not-found",
          });
        }

        const blockTypes = await blockTypesByName();
        const validation = validatePageContent(
          pageType,
          blockTypes,
          { blocks: blocks as PageBlock[] },
          { allowUnavailableBlocks: true, allowNotAllowedBlocks: false },
        );
        if (!validation.ok) {
          return issuesResult(
            `The blocks do not validate: ${validation.issues.length} issue(s).`,
            "invalid",
            { issues: validation.issues },
          );
        }

        const guidance = await pageImageGuidance(
          blockTypes,
          blocks as PageBlock[],
        );
        if (guidance.issues.length > 0) {
          return issuesResult(
            `The images do not meet their guidance: ${guidance.issues.length} issue(s).`,
            "invalid",
            { issues: guidance.issues },
          );
        }

        return okResult({
          ok: true,
          page: summarizePage(page),
          ...(guidance.warnings.length > 0
            ? { warnings: guidance.warnings }
            : {}),
        });
      }),
  );

  server.registerTool(
    "save_slot",
    {
      title: "Save slot draft",
      description:
        "Save a draft revision of one slot. This does NOT publish: the site keeps rendering the published revision until publish_slot. Pass the baseRevisionId get_slot returned; a stale one is refused rather than overwriting someone else's work.",
      inputSchema: z.object({
        slot: z.string().min(1).describe("Slot name, e.g. home.hero."),
        baseRevisionId: z
          .string()
          .uuid()
          .nullable()
          .describe(
            "The revision get_slot returned, or null when the slot has none.",
          ),
        content: z
          .record(z.string(), z.unknown())
          .describe("The block's field values, keyed by field name."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ slot: handle, baseRevisionId, content }) =>
      guard("save_slot", async () => {
        if (tooLarge(content)) return tooLargeResult();
        const slot = await findSlot(handle);
        if (!slot) {
          return errorResult(`No slot named "${handle}".`, {
            reason: "not-found",
          });
        }

        // A retried request after a dropped response should not append a
        // second identical revision or report a conflict with itself.
        const latest = await getLatestRevision("slot", slot.id);
        if (
          latest &&
          baseRevisionId === latest.id &&
          Bun.deepEquals(latest.content, content)
        ) {
          return okResult({
            ok: true,
            revisionId: latest.id,
            unchanged: true,
            message:
              "The content is identical to the newest revision; nothing was written.",
          });
        }

        const result = await saveSlotDraft({
          slotId: slot.id,
          slot,
          content,
          baseRevisionId,
          actorId,
        });

        if (result.ok) {
          return okResult(
            written(
              {
                ok: true,
                revisionId: result.revision.id,
                unchanged: false,
                createdAt: result.revision.createdAt.toISOString(),
              },
              result.warnings,
            ),
          );
        }

        if (result.reason === "invalid") {
          return issuesResult(
            `The draft was not saved: ${result.issues.length} field issue(s).`,
            "invalid",
            { issues: result.issues },
          );
        }

        return issuesResult(
          "A newer draft exists. Call get_slot again, reapply your change, and save with the new baseRevisionId.",
          "conflict",
          { newer: result.newer },
        );
      }),
  );

  server.registerTool(
    "save_page",
    {
      title: "Save page draft",
      description:
        "Save a page's settings and blocks as a new draft revision. This does NOT publish. Pass the baseRevisionId get_page returned. Settings you omit keep their current values; blocks replace the draft's blocks.",
      inputSchema: z.object({
        id: z.string().optional(),
        url: z.string().optional(),
        baseRevisionId: z
          .string()
          .uuid()
          .nullable()
          .describe(
            "The revision get_page returned, or null when the page has none.",
          ),
        settings: z
          .object({
            pageType: z.string().optional(),
            url: z.string().optional(),
            title: z.string().optional(),
            seoDescription: z.string().nullable().optional(),
            socialImage: z.string().nullable().optional(),
          })
          .optional(),
        blocks: z
          .array(z.looseObject({ type: z.string() }))
          .optional()
          .describe(
            "The page's blocks, replacing the draft's. Omit to keep the current draft's blocks (for a settings-only change).",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, url, baseRevisionId, settings, blocks }) =>
      guard("save_page", async () => {
        if (!id && !url) {
          return errorResult("Pass either id or url.", { reason: "invalid" });
        }
        const page = await findPage({ id, url });
        if (!page) {
          return errorResult(`No page for ${id ?? url}.`, {
            reason: "not-found",
          });
        }

        const latest = await getLatestRevision("page", page.id);
        const resolvedBlocks =
          blocks ?? (latest ? asPageContent(latest.content).blocks : null);
        if (!resolvedBlocks) {
          return issuesResult(
            "This page has no draft yet, so there are no blocks to keep. Pass blocks.",
            "no-draft",
          );
        }
        const content = { blocks: resolvedBlocks as PageBlock[] };
        if (tooLarge(content)) return tooLargeResult();

        // The form can only offer the blocks a page type allows, so the save
        // path tolerates a not-allowed block to keep an existing page editable
        // after a page-type change. An MCP caller has no form: it can add any
        // block it likes, so the tool checks the rule the form would have
        // enforced. Removed block types stay tolerated (the save path carries
        // them) — rejecting those would make an old page unsaveable.
        const targetPageType = await getPageTypeByName(
          settings?.pageType ?? page.pageType,
        );
        if (!targetPageType) {
          return errorResult(
            `Page type "${settings?.pageType ?? page.pageType}" is not published.`,
            { reason: "not-found" },
          );
        }
        const ruleCheck = validatePageContent(
          targetPageType,
          await blockTypesByName(),
          content,
          { allowUnavailableBlocks: true, allowNotAllowedBlocks: false },
        );
        if (!ruleCheck.ok) {
          return issuesResult(
            `The page was not saved: ${ruleCheck.issues.length} block rule issue(s).`,
            "invalid",
            { issues: ruleCheck.issues },
          );
        }

        if (
          settings === undefined &&
          latest &&
          baseRevisionId === latest.id &&
          Bun.deepEquals(latest.content, content)
        ) {
          return okResult({
            ok: true,
            revisionId: latest.id,
            unchanged: true,
            page: summarizePage(page),
            message:
              "The content is identical to the newest revision; nothing was written.",
          });
        }

        const result = await savePage({
          pageId: page.id,
          page,
          settings: {
            pageType: settings?.pageType ?? page.pageType,
            // The saved draft address is what the editor shows, and passing the
            // live one back would read as "revert the move" and clear it.
            url: settings?.url ?? page.draftUrl ?? page.url,
            title: settings?.title ?? page.title,
            seoDescription:
              settings?.seoDescription !== undefined
                ? settings.seoDescription
                : page.seoDescription,
            socialImage:
              settings?.socialImage !== undefined
                ? settings.socialImage
                : page.socialImage,
          },
          content,
          baseRevisionId,
          actorId,
        });

        if (result.ok) {
          return okResult(
            written(
              {
                ok: true,
                revisionId: result.revision.id,
                unchanged: false,
                createdAt: result.revision.createdAt.toISOString(),
                page: summarizePage(result.page),
              },
              result.warnings,
            ),
          );
        }

        if (result.reason === "settings") {
          return issuesResult(
            `The page settings were not saved: ${result.issues.length} issue(s).`,
            "invalid",
            { issues: result.issues },
          );
        }
        if (result.reason === "invalid") {
          return issuesResult(
            `The page was not saved: ${result.issues.length} issue(s).`,
            "invalid",
            { issues: result.issues },
          );
        }

        return issuesResult(
          "A newer draft exists. Call get_page again, reapply your change, and save with the new baseRevisionId.",
          "conflict",
          { newer: result.newer },
        );
      }),
  );

  server.registerTool(
    "publish_slot",
    {
      title: "Publish slot",
      description:
        "Make a slot revision live. The site picks it up within about a second. This is the step that changes the public site; publish only when the person asked for it. With no revisionId it publishes the newest draft; an explicit revisionId publishes exactly that revision, which is how an older good version is put back live (newer drafts are kept).",
      inputSchema: z.object({
        slot: z.string().min(1).describe("Slot name, e.g. home.hero."),
        revisionId: z
          .string()
          .uuid()
          .optional()
          .describe("Publish this revision. Omit to publish the newest draft."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ slot: handle, revisionId }) =>
      guard("publish_slot", async () => {
        const slot = await findSlot(handle);
        if (!slot) {
          return errorResult(`No slot named "${handle}".`, {
            reason: "not-found",
          });
        }

        // An explicit revision is a deliberate choice — "put this one live",
        // including rolling back to a good older version. Publishing it cannot
        // lose the newer drafts (revisions are immutable), so it is not the
        // stale-write case a save guards against. Omitting the id means "the
        // newest draft".
        const result = await publishSlot({
          slotId: slot.id,
          slot,
          revisionId,
        });

        if (result.ok) {
          return okResult(
            written(
              {
                ok: true,
                revisionId: result.revisionId,
                contentVersion: result.contentVersion,
                changed: result.changed,
              },
              result.warnings,
            ),
          );
        }
        if (result.reason === "no-draft") {
          return issuesResult("There is no draft to publish.", "no-draft");
        }
        if (result.reason === "invalid") {
          return issuesResult(
            `The draft was not published: ${result.issues.length} field issue(s).`,
            "invalid",
            { issues: result.issues },
          );
        }
        return issuesResult(
          "A newer draft arrived while this one was being published, so nothing went live. Call get_slot, review the newer draft, and publish it.",
          "stale",
          { latestRevisionId: result.latestRevisionId },
        );
      }),
  );

  server.registerTool(
    "publish_page",
    {
      title: "Publish page",
      description:
        "Make a page revision live at its URL. The site picks it up within about a second. This is the step that changes the public site; publish only when the person asked for it. With no revisionId it publishes the newest draft; an explicit revisionId publishes exactly that revision, which is how an older good version is put back live (newer drafts are kept).",
      inputSchema: z.object({
        id: z.string().optional(),
        url: z.string().optional(),
        revisionId: z
          .string()
          .uuid()
          .optional()
          .describe("Publish this revision. Omit to publish the newest draft."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, url, revisionId }) =>
      guard("publish_page", async () => {
        if (!id && !url) {
          return errorResult("Pass either id or url.", { reason: "invalid" });
        }
        const page = await findPage({ id, url });
        if (!page) {
          return errorResult(`No page for ${id ?? url}.`, {
            reason: "not-found",
          });
        }

        // Same rule as publish_slot: an explicit revision is a deliberate
        // choice, so an older good version can be put back live while the
        // newer draft stays in history.
        const result = await publishPage({
          pageId: page.id,
          page,
          revisionId,
        });

        if (result.ok) {
          return okResult(
            written(
              {
                ok: true,
                revisionId: result.revisionId,
                contentVersion: result.contentVersion,
                changed: result.changed,
                page: summarizePage(page),
              },
              result.warnings,
            ),
          );
        }
        if (result.reason === "no-draft") {
          return issuesResult("There is no draft to publish.", "no-draft");
        }
        if (result.reason === "invalid") {
          return issuesResult(
            `The page was not published: ${result.issues.length} issue(s).`,
            "invalid",
            { issues: result.issues },
          );
        }
        if (result.reason === "duplicate") {
          return issuesResult(result.issue.message, "invalid", {
            issues: [result.issue],
          });
        }
        return issuesResult(
          "A newer draft arrived while this one was being published, so nothing went live. Call get_page, review the newer draft, and publish it.",
          "stale",
          { latestRevisionId: result.latestRevisionId },
        );
      }),
  );
};
