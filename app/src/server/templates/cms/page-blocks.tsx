import { ContentFields } from "../../components/cms/content-fields";
import type { FieldError } from "../../components/cms/field-control";
import type {
  BlockTypeRecord,
  PageBlock,
  PageTypeRecord,
  UnavailableBlock,
} from "../../services/content";
import type { PageOption } from "../../services/content/pages";

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

/** Why a block can't be edited, as a sentence fragment. */
const unavailableNote = (
  reason: UnavailableBlock["reason"] | undefined,
): string => {
  if (reason === "removed") return " — its type was removed by a deploy";
  if (reason === "not-allowed") return " — the page type no longer allows it";
  return "";
};

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
}: {
  blockType: BlockTypeRecord;
  block: PageBlock;
  index: number;
  errors?: Map<string, FieldError[]>;
  pages?: PageOption[];
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
 * deploy removed) renders as a flagged, read-only entry: it has no controls to
 * serialize, so a save leaves it to the write layer to carry through (Q4), and
 * it refuses to publish until the deploy restores it.
 */
export const PageBlocks = ({
  pageType,
  blockTypes,
  blocks,
  unavailable,
  errorsByBlock,
  pages,
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
            return (
              <fieldset
                className="cms-block cms-block-unavailable"
                data-cms-block
                data-block-unavailable
                data-block-type={block.type}
                key={`${block.type}:${index}`}
              >
                <legend className="cms-block-legend">
                  <code>{block.type}</code>
                </legend>
                <p className="flash-warning" role="status">
                  This block is no longer editable
                  {unavailableNote(flagged?.reason)}. Its saved content is kept
                  as it is, and the page can't be published until a deploy
                  restores the block.
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
