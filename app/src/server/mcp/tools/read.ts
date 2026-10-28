/**
 * The read half of the MCP tool suite.
 *
 * Every tool is a thin read over `services/content` or `services/media`; none
 * of them writes. The shapes are chosen for a model: one orientation call
 * (`get_context`), then a target call that returns both the current draft and
 * the schema it has to satisfy, so the model never has to guess a field name.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  asPageContent,
  buildPreviewUrl,
  createPreviewToken,
  getBlockTypeByName,
  getLatestRevision,
  getPageById,
  getPageByUrl,
  getPageTypeByName,
  getRevisionById,
  getSlotById,
  getSlotByName,
  listBlockTypes,
  listPageHistory,
  listPageStates,
  listPages,
  listPageTypes,
  listSlotHistory,
  listSlotStates,
  listSlots,
  type PageRecord,
  type RevisionRecord,
  type SlotRecord,
} from "../../services/content";
import { listMedia } from "../../services/media";
import { SITE_NAME } from "../../services/seo";
import type { McpActor } from "../auth";
import { errorResult, iso, okResult, paginate, UUID_PATTERN } from "../results";

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

type TargetState = "live" | "draft" | "never";

const stateOf = (
  publishedRevisionId: string | null,
  latest: RevisionRecord | null,
): TargetState => {
  if (publishedRevisionId === null) return "never";
  if (latest && latest.id !== publishedRevisionId) return "draft";
  return "live";
};

const resolveTarget = async (
  target: "slot" | "page",
  handle: string,
): Promise<SlotRecord | PageRecord | null> => {
  if (target === "slot") return findSlot(handle);
  // The one-handle form has to pick: a UUID is an id, anything else is a URL.
  // Passing it as both lets `findPage` prefer the id and miss every URL.
  return UUID_PATTERN.test(handle) ? getPageById(handle) : getPageByUrl(handle);
};

export const registerReadTools = (
  server: McpServer,
  actor: McpActor | null,
): void => {
  server.registerTool(
    "get_context",
    {
      title: "Get CMS context",
      description:
        "Start here. Returns the site, the user this connection acts as, and a bounded map of slots, pages, page types and block types. Call this before any other tool.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const [slots, slotStates, pages, pageStates, pageTypes, blockTypes] =
        await Promise.all([
          listSlots(),
          listSlotStates(),
          listPages(),
          listPageStates(),
          listPageTypes(),
          listBlockTypes(),
        ]);

      const slotPage = paginate(slots, 50, 0);
      const pagePage = paginate(pages, 25, 0);

      return okResult({
        site: {
          name: SITE_NAME,
          url: process.env.SITE_APP_URL ?? null,
        },
        identity: actor ? { email: actor.email, role: actor.role } : null,
        slots: slotPage.items.map((slot) => ({
          name: slot.name,
          page: slot.page,
          label: slot.label,
          blockType: slot.blockName,
          state: slotStates.get(slot.id)?.kind ?? "never",
          removed: slot.removedAt !== null,
        })),
        slotCount: slotPage.total,
        pages: pagePage.items.map((page) => ({
          id: page.id,
          url: page.url,
          title: page.title,
          pageType: page.pageType,
          state: pageStates.get(page.id)?.kind ?? "never",
        })),
        pageCount: pagePage.total,
        pageTypes: pageTypes.map((pageType) => ({
          name: pageType.name,
          label: pageType.label,
          allowedBlocks: pageType.allowedBlocks,
          requiredBlocks: pageType.requiredBlocks,
        })),
        blockTypes: blockTypes.map((blockType) => blockType.name),
      });
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get profile",
      description:
        "Return the CMS user this connection acts as. Used by clients to label and de-duplicate connections.",
      inputSchema: z.object({}),
      outputSchema: z
        .object({
          id: z.string().min(1),
          name: z.string().optional(),
          email: z.string().optional(),
          nickname: z.string().optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: { "openai/profile": true },
    },
    async () => {
      if (!actor) {
        return errorResult(
          "This connection has no identity. Set MCP_DEV_IDENTITY_EMAIL to a cms_identities email.",
        );
      }
      return okResult({
        id: actor.id,
        email: actor.email,
        nickname: actor.email,
      });
    },
  );

  server.registerTool(
    "list_slots",
    {
      title: "List slots",
      description:
        "List the content slots the site's templates declared, with whether each is live, has a draft, or was never published.",
      inputSchema: z.object({
        page: z
          .string()
          .optional()
          .describe("Filter by the slot's page group."),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ page, limit, offset }) => {
      const [slots, states] = await Promise.all([
        listSlots(),
        listSlotStates(),
      ]);
      const filtered = page
        ? slots.filter((slot) => slot.page === page)
        : slots;
      const result = paginate(filtered, limit, offset);

      return okResult({
        slots: result.items.map((slot) => ({
          id: slot.id,
          name: slot.name,
          page: slot.page,
          label: slot.label,
          blockType: slot.blockName,
          previewPath: slot.previewPath,
          state: states.get(slot.id)?.kind ?? "never",
          removed: slot.removedAt !== null,
        })),
        total: result.total,
      });
    },
  );

  server.registerTool(
    "get_slot",
    {
      title: "Get slot",
      description:
        "Read one slot: its current draft, the block's field tree, the revision the draft is based on, and the published content. Use the returned baseRevisionId when saving.",
      inputSchema: z.object({
        slot: z
          .string()
          .min(1)
          .describe("Slot name, e.g. home.hero, or its id."),
        includeSchema: z
          .boolean()
          .default(false)
          .describe(
            "Include the block's published JSON Schema. Usually unnecessary: fields describes every control.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ slot: handle, includeSchema }) => {
      const slot = await findSlot(handle);
      if (!slot) {
        return errorResult(`No slot named "${handle}".`, {
          reason: "not-found",
        });
      }

      const blockType = await getBlockTypeByName(slot.blockName);
      if (!blockType) {
        return errorResult(
          `Slot "${slot.name}" uses block "${slot.blockName}", which the site has not published.`,
          { reason: "not-found" },
        );
      }

      const latest = await getLatestRevision("slot", slot.id);
      const published =
        slot.publishedRevisionId && slot.publishedRevisionId !== latest?.id
          ? await getRevisionById(slot.publishedRevisionId)
          : latest;

      return okResult({
        slot: {
          id: slot.id,
          name: slot.name,
          page: slot.page,
          label: slot.label,
          help: slot.help,
          blockType: slot.blockName,
          previewPath: slot.previewPath,
          state: stateOf(slot.publishedRevisionId, latest),
          baseRevisionId: latest?.id ?? null,
          publishedRevisionId: slot.publishedRevisionId,
          lastSavedAt: iso(latest?.createdAt),
          removed: slot.removedAt !== null,
        },
        fields: blockType.fields,
        draft: latest?.content ?? null,
        published: published?.content ?? null,
        ...(includeSchema ? { jsonSchema: blockType.jsonSchema } : {}),
      });
    },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List the pages editors created in the CMS, with their URL and whether they are live or have an unpublished draft.",
      inputSchema: z.object({
        pageType: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ pageType, limit, offset }) => {
      const [pages, states] = await Promise.all([
        listPages(),
        listPageStates(),
      ]);
      const filtered = pageType
        ? pages.filter((page) => page.pageType === pageType)
        : pages;
      const result = paginate(filtered, limit, offset);

      return okResult({
        pages: result.items.map((page) => ({
          id: page.id,
          url: page.url,
          title: page.title,
          pageType: page.pageType,
          state: states.get(page.id)?.kind ?? "never",
        })),
        total: result.total,
      });
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description:
        "Read one page: its settings, its page type's rules, the field tree of every block it contains, the draft blocks, and the published blocks. Use the returned baseRevisionId when saving.",
      inputSchema: z.object({
        id: z.string().optional().describe("Page id."),
        url: z.string().optional().describe("Page URL, e.g. /pricing."),
        includeSchema: z
          .boolean()
          .default(false)
          .describe("Include each block's published JSON Schema."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, url, includeSchema }) => {
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
        return errorResult(
          `Page "${page.url}" uses page type "${page.pageType}", which the site has not published.`,
          { reason: "not-found" },
        );
      }

      const latest = await getLatestRevision("page", page.id);
      const published =
        page.publishedRevisionId && page.publishedRevisionId !== latest?.id
          ? await getRevisionById(page.publishedRevisionId)
          : latest;

      const draft = latest ? asPageContent(latest.content) : { blocks: [] };
      const types = new Set(draft.blocks.map((block) => block.type));
      for (const block of published
        ? asPageContent(published.content).blocks
        : []) {
        types.add(block.type);
      }

      const blocks = await Promise.all(
        [...types].map(async (type) => {
          const blockType = await getBlockTypeByName(type);
          if (!blockType) return { type, missing: true };
          return {
            type,
            fields: blockType.fields,
            removed: blockType.removedAt !== null,
            ...(includeSchema ? { jsonSchema: blockType.jsonSchema } : {}),
          };
        }),
      );

      return okResult({
        page: {
          id: page.id,
          url: page.url,
          title: page.title,
          pageType: page.pageType,
          seoDescription: page.seoDescription,
          socialImage: page.socialImage,
          state: stateOf(page.publishedRevisionId, latest),
          baseRevisionId: latest?.id ?? null,
          publishedRevisionId: page.publishedRevisionId,
          lastSavedAt: iso(latest?.createdAt),
        },
        pageType: {
          name: pageType.name,
          label: pageType.label,
          help: pageType.help,
          allowedBlocks: pageType.allowedBlocks,
          requiredBlocks: pageType.requiredBlocks,
          limits: pageType.limits,
        },
        blocks,
        draft: latest?.content ?? null,
        published: published?.content ?? null,
      });
    },
  );

  server.registerTool(
    "list_revisions",
    {
      title: "List revisions",
      description:
        "List a page's or slot's saved revisions, newest first, with author and whether each is live. Use the id with publish_page/publish_slot to publish an older revision.",
      inputSchema: z.object({
        target: z.enum(["slot", "page"]),
        handle: z
          .string()
          .min(1)
          .describe("Slot name/id, or a page id or URL."),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, handle, limit }) => {
      const subject = await resolveTarget(target, handle);
      if (!subject) {
        return errorResult(`No ${target} for "${handle}".`, {
          reason: "not-found",
        });
      }

      const history =
        target === "slot"
          ? await listSlotHistory(subject as SlotRecord)
          : {
              revisions: await listPageHistory(subject as PageRecord),
              hasOlder: false,
            };
      const shown = history.revisions.slice(0, limit);

      return okResult({
        revisions: shown.map((revision) => ({
          id: revision.id,
          createdAt: iso(revision.createdAt),
          authorEmail: revision.authorEmail,
          isPublished: revision.isPublished,
          isLatest: revision.isLatest,
        })),
        hasOlder: history.hasOlder || history.revisions.length > limit,
      });
    },
  );

  server.registerTool(
    "get_revision",
    {
      title: "Get revision",
      description:
        "Read one revision's stored content by id, for inspecting an older draft before publishing it.",
      inputSchema: z.object({ revisionId: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ revisionId }) => {
      const revision = await getRevisionById(revisionId);
      if (!revision) {
        return errorResult(`No revision ${revisionId}.`, {
          reason: "not-found",
        });
      }
      return okResult({
        id: revision.id,
        targetType: revision.targetType,
        targetId: revision.targetId,
        createdAt: iso(revision.createdAt),
        content: revision.content,
      });
    },
  );

  server.registerTool(
    "list_media",
    {
      title: "List media",
      description:
        "List the image library, newest first. Use an image's id in an image field as {mediaId, alt?}.",
      inputSchema: z.object({
        query: z.string().optional().describe("Filter by alt text."),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit, offset }) => {
      const all = await listMedia();
      const needle = query?.trim().toLowerCase();
      const filtered = needle
        ? all.filter((item) => item.alt.toLowerCase().includes(needle))
        : all;
      const result = paginate(filtered, limit, offset);

      return okResult({
        media: result.items.map((item) => {
          const widest = [...item.variants].sort(
            (a, b) => b.width - a.width,
          )[0];
          return {
            id: item.id,
            alt: item.alt,
            width: item.width,
            height: item.height,
            createdAt: iso(item.createdAt),
            url: widest?.webpUrl ?? null,
          };
        }),
        total: result.total,
      });
    },
  );

  server.registerTool(
    "get_preview_url",
    {
      title: "Get preview URL",
      description:
        "Mint a 30-minute preview link that renders the current draft on the real site. Show it to the person instead of publishing.",
      inputSchema: z.object({
        target: z.enum(["slot", "page"]),
        handle: z
          .string()
          .min(1)
          .describe("Slot name/id, or a page id or URL."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, handle }) => {
      const subject = await resolveTarget(target, handle);
      if (!subject) {
        return errorResult(`No ${target} for "${handle}".`, {
          reason: "not-found",
        });
      }

      const path =
        target === "slot"
          ? (subject as SlotRecord).previewPath
          : (subject as PageRecord).url;
      const token = await createPreviewToken({
        subjectType: target,
        subjectId: subject.id,
        createdBy: actor?.id ?? null,
      });
      const url = buildPreviewUrl({
        baseUrl: process.env.SITE_APP_URL,
        path,
        rawToken: token.rawToken,
      });

      if (!url) {
        return errorResult(
          "Could not build a preview URL: SITE_APP_URL is not a valid http(s) origin.",
          { reason: "invalid" },
        );
      }

      return okResult({
        url,
        path,
        subjectType: target,
        expiresAt: iso(token.expiresAt),
      });
    },
  );
};
