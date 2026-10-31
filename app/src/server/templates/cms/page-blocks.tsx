import { ContentFields } from "../../components/cms/content-fields";
import type { FieldError } from "../../components/cms/field-control";
import type { PickerImage } from "../../components/cms/image-picker";
import { Flash } from "../../components/flash";
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
  /**
   * Messages that belong to a whole block rather than a field — the hero-first
   * rule and the rich-text nesting bound — keyed by the block's index. They are
   * shown on the block itself as well as in the banner, because at 390 the
   * banner is several screens above the block it is about.
   */
  alertsByBlock?: Map<number, string>;
  /** The CMS pages a `link` field's picker offers. */
  pages?: PageOption[];
  /**
   * The uploads the blocks' `image` fields currently reference, keyed by media
   * id. One map serves every block and list row.
   */
  pickerImages?: Map<string, PickerImage>;
  /** The CSRF token bound to `POST /cms/media`, for the pickers' drop zones. */
  uploadCsrfToken: string;
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

/** A block type's `max` on this page type, when it is a usable number. */
const blockMax = (
  pageType: PageTypeRecord,
  name: string,
): number | undefined => {
  const limit = pageType.limits[name];
  if (typeof limit !== "object" || limit === null) return undefined;
  const { max } = limit as { max?: unknown };
  return typeof max === "number" && Number.isFinite(max) ? max : undefined;
};

/** Whether the page already holds a block type's maximum. */
const atLimit = (
  pageType: PageTypeRecord,
  blocks: PageBlock[],
  name: string,
): boolean => {
  const max = blockMax(pageType, name);
  if (max === undefined) return false;
  // The server counts every stored block of the type, flagged ones included.
  return blocks.filter((block) => block.type === name).length >= max;
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
const FlaggedBlockActions = () => (
  <div className="cms-block-actions">
    <button
      type="button"
      className="cms-block-remove"
      data-block-remove
      aria-label="Remove the unavailable block"
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
  alert,
  pages,
  pickerImages,
  uploadCsrfToken,
}: {
  blockType: BlockTypeRecord;
  block: PageBlock;
  index: number;
  errors?: Map<string, FieldError[]>;
  alert?: string;
  pages?: PageOption[];
  pickerImages?: Map<string, PickerImage>;
  uploadCsrfToken: string;
}) => (
  <fieldset
    className={alert ? "cms-block cms-block-alert" : "cms-block"}
    data-cms-block
    data-block-type={blockType.name}
    data-block-index={index}
    // The banner links here, so a whole-block message in it can be reached at
    // 390 without scrolling past the rest of the form to find the block.
    id={index >= 0 ? `block-${index + 1}` : undefined}
  >
    <legend className="cms-block-legend">
      {/* The number is generated by a CSS counter on `.cms-block`, so it
          follows the block's place in the list after any add, move or remove
          without an index stored in the markup. */}
      <code>{blockType.label}</code>
    </legend>
    <BlockActions label={blockType.label} />
    {alert && (
      <p className="cms-block-alert-message" role="alert">
        {alert}
      </p>
    )}
    <ContentFields
      fields={blockType.fields}
      content={block}
      errorsByField={errors}
      pages={pages}
      pickerImages={pickerImages}
      uploadCsrfToken={uploadCsrfToken}
      idPrefix={`cms-block-${index}-${blockType.name}`}
    />
  </fieldset>
);

/**
 * The page's block list: one control set per stored block, a template for each
 * block type the page type allows, and one Add block menu for the types the
 * page can still take.
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
  alertsByBlock,
  pages,
  pickerImages,
  uploadCsrfToken,
}: PageBlocksProps) => {
  const byName = new Map(blockTypes.map((block) => [block.name, block]));
  const unavailableByIndex = new Map(
    unavailable.map((entry) => [entry.index, entry]),
  );
  const allowed = allowedBlockTypes(pageType, blockTypes);
  // Every allowed type gets a menu item. One already at its maximum is rendered
  // `hidden` rather than left out, so removing that block in this tab can bring
  // it back without a round trip; the control itself hides when all are full.
  const addable = allowed.filter(
    (blockType) => !atLimit(pageType, blocks, blockType.name),
  );

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
                id={`block-${index + 1}`}
                key={`${block.type}:${index}`}
              >
                <legend className="cms-block-legend">
                  <code>Unavailable block</code>
                </legend>
                <FlaggedBlockActions />
                <Flash tone="warning" title={unavailableMessage(reason)} />
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
              alert={alertsByBlock?.get(index)}
              pages={pages}
              pickerImages={pickerImages}
              uploadCsrfToken={uploadCsrfToken}
            />
          );
        })}
      </div>

      {/* Rendered even with blocks, so the client can bring it back when the
          last one is removed. It is hidden from the start when a block is
          already there, and `cms-form.ts` keeps it in step with the list. */}
      <p
        className="cms-blocks-empty"
        data-cms-blocks-empty
        hidden={blocks.length > 0}
      >
        This page has no blocks yet. Add one below.
      </p>

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
            pickerImages={pickerImages}
            uploadCsrfToken={uploadCsrfToken}
          />
        </template>
      ))}

      {allowed.length === 0 ? (
        <p className="cms-blocks-empty">
          The page type doesn't allow any blocks.
        </p>
      ) : (
        // One Add control for every type the page can take. The menu is always
        // rendered — `cms-form.ts` keeps it in step with the blocks the editor
        // adds and removes — and the whole control is hidden when no type is
        // left, so nothing says "off" or explains a limit.
        <div
          className="cms-block-add"
          hidden={addable.length === 0}
          data-block-add-area
        >
          <button
            type="button"
            id="cms-block-add-button"
            className="cms-block-add-button"
            data-block-add-toggle
            aria-haspopup="menu"
            aria-expanded="false"
            aria-controls="cms-block-add-menu"
          >
            Add block
          </button>
          <div
            className="cms-block-add-menu"
            id="cms-block-add-menu"
            role="menu"
            aria-labelledby="cms-block-add-button"
            data-block-add-menu
            hidden
          >
            {allowed.map((blockType) => (
              <button
                type="button"
                role="menuitem"
                className="cms-block-add-item"
                data-block-add={blockType.name}
                data-block-max={blockMax(pageType, blockType.name)}
                hidden={atLimit(pageType, blocks, blockType.name)}
                key={blockType.name}
              >
                {blockType.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
