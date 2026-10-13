import { ContentFields } from "../../components/cms/content-fields";
import type { FieldError } from "../../components/cms/field-control";
import type {
  BlockTypeRecord,
  PageBlock,
  PageTypeRecord,
  UnavailableBlock,
} from "../../services/content";
import type { PageOption } from "../../services/content/pages";
import type { MediaOption } from "../../services/media";

export interface PageBlocksProps {
  pageType: PageTypeRecord;
  /** Every published block type, for rendering a block's controls. */
  blockTypes: BlockTypeRecord[];
  /** The page's stored blocks, in order. */
  blocks: PageBlock[];
  /** The blocks whose type can't be edited (Q4), keyed by their index. */
  unavailable: UnavailableBlock[];
  /** Validation messages for one block's fields, keyed by the block's index. */
  errorsByBlock?: Map<number, Map<string, FieldError[]>>;
  /** The CMS pages a `link` field's picker offers. */
  pages?: PageOption[];
  /** The uploads an `image` field's picker offers. */
  media?: MediaOption[];
}

/** The block types a page of this type may add, in the allowed order. */
const allowedBlockTypes = (
  pageType: PageTypeRecord,
  blockTypes: BlockTypeRecord[],
): BlockTypeRecord[] => {
  const byName = new Map(blockTypes.map((block) => [block.name, block]));
  return pageType.allowedBlocks
    .map((name) => byName.get(name))
    .filter((block): block is BlockTypeRecord =>
      Boolean(block && !block.removedAt),
    );
};

/**
 * Why a block can't be edited, and what clears the flag.
 *
 * A removed or missing block type can't be rendered by the site, so the page
 * can't be published while it holds one. A block the page type no longer allows
 * is still a published, renderable block, so the page can be published anyway
 * (review round 2). Either way the editor can remove the block explicitly.
 */
const unavailableMessage = (reason: UnavailableBlock["reason"]): string => {
  if (reason === "not-allowed") {
    return "This block isn't allowed on this page type any more. Its saved content is kept and the page can still be published; remove the block to clear the flag.";
  }
  if (reason === "removed") {
    return "This block's type was removed by a deploy. Its saved content is kept, but the page can't be published until the block is removed or a deploy restores its type.";
  }
  return "This block's type is no longer published. Its saved content is kept, but the page can't be published until the block is removed or a deploy restores its type.";
};

/**
 * The Remove control on a flagged block.
 *
 * The payload is not the block: the client can't serialize fields it has no
 * controls for. Clicking Remove marks the block removed in the form's
 * `removed_blocks` field, which is the explicit marker the write layer reads.
 */
const FlaggedBlockActions = ({ type }: { type: string }) => (
  <div className="cms-block-actions">
    <button
      type="button"
      className="cms-block-remove"
      data-block-remove
      aria-label={`Remove the ${type} block`}
    >
      Remove
    </button>
  </div>
);

const BlockActions = ({ label }: { label: string }) => (
  <div className="cms-block-actions">
    <button
      type="button"
      className="cms-block-move"
      data-block-up
      aria-label={`Move the ${label} block up`}
      title="Move up"
    >
      ↑
    </button>
    <button
      type="button"
      className="cms-block-move"
      data-block-down
      aria-label={`Move the ${label} block down`}
      title="Move down"
    >
      ↓
    </button>
    <button
      type="button"
      className="cms-block-remove"
      data-block-remove
      aria-label={`Remove the ${label} block`}
    >
      Remove
    </button>
  </div>
);

/** One editable block: its type, its fields, and the buttons that move it. */
const EditableBlock = ({
  blockType,
  block,
  index,
  errors,
  pages,
  media,
}: {
  blockType: BlockTypeRecord;
  block: PageBlock;
  index: number;
  errors?: Map<string, FieldError[]>;
  pages?: PageOption[];
  media?: MediaOption[];
}) => (
  <fieldset
    className="cms-block"
    data-cms-block
    data-block-type={blockType.name}
    data-block-index={index}
  >
    <legend className="cms-block-legend">
      <code>{blockType.name}</code>
    </legend>
    <BlockActions label={blockType.name} />
    <ContentFields
      fields={blockType.fields}
      content={block}
      errorsByField={errors}
      pages={pages}
      media={media}
      idPrefix={`cms-block-${index}-${blockType.name}`}
    />
  </fieldset>
);

/**
 * The page's block list: one control set per stored block, a template for each
 * block type the page type allows, and an Add button per type.
 *
 * `data-cms-block` elements are what the client walks back into the hidden
 * `content` field. A block the page type no longer allows (or whose type a
 * deploy removed) renders as a flagged, read-only entry: it has no field
 * controls to serialize, so a save leaves it to the write layer to carry
 * through (Q4). Its one control is Remove, which marks the block's base index
 * in the form's `removed_blocks` field — the explicit removal the write layer
 * reads so the block isn't carried back (review round 2). A removed block type
 * still refuses to publish; a not-allowed one can be published as it stands.
 */
export const PageBlocks = ({
  pageType,
  blockTypes,
  blocks,
  unavailable,
  errorsByBlock,
  pages,
  media,
}: PageBlocksProps) => {
  const byName = new Map(blockTypes.map((block) => [block.name, block]));
  const unavailableByIndex = new Map(
    unavailable.map((entry) => [entry.index, entry]),
  );
  const allowed = allowedBlockTypes(pageType, blockTypes);

  return (
    <div className="cms-page-content" data-cms-page-content>
      <div className="cms-blocks" data-cms-blocks>
        {blocks.map((block, index) => {
          const flagged = unavailableByIndex.get(index);
          const blockType = byName.get(block.type);
          if (flagged || !blockType || blockType.removedAt) {
            const reason =
              flagged?.reason ?? (blockType?.removedAt ? "removed" : "missing");
            return (
              <fieldset
                className="cms-block cms-block-unavailable"
                data-cms-block
                data-block-unavailable
                data-block-type={block.type}
                data-block-index={index}
                key={`${block.type}:${index}`}
              >
                <legend className="cms-block-legend">
                  <code>{block.type}</code>
                </legend>
                <FlaggedBlockActions type={block.type} />
                <p className="flash-warning" role="status">
                  {unavailableMessage(reason)}
                </p>
              </fieldset>
            );
          }
          return (
            <EditableBlock
              key={`${block.type}:${index}`}
              blockType={blockType}
              block={block}
              index={index}
              errors={errorsByBlock?.get(index)}
              pages={pages}
              media={media}
            />
          );
        })}
      </div>

      {blocks.length === 0 && (
        <p className="cms-blocks-empty">
          This page has no blocks yet. Add one below.
        </p>
      )}

      {/* One empty block per allowed type, cloned by the editor when Add is
          pressed. Never in the form's query scope, so it is not serialized. */}
      {allowed.map((blockType) => (
        <template
          data-cms-block-template
          data-block-type={blockType.name}
          key={blockType.name}
        >
          <EditableBlock
            blockType={blockType}
            block={{ type: blockType.name }}
            index={-1}
            pages={pages}
            media={media}
          />
        </template>
      ))}

      <div className="cms-block-add">
        {allowed.length === 0 ? (
          <p className="cms-blocks-empty">
            The page type doesn't allow any blocks.
          </p>
        ) : (
          allowed.map((blockType) => (
            <button
              type="button"
              className="cms-block-add-button"
              data-block-add={blockType.name}
              key={blockType.name}
            >
              Add {blockType.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
