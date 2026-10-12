import { ContentFields } from "../../components/cms/content-fields";
import { Layout } from "../../components/layouts";
import { getAssetUrl } from "../../services/assets";
import type {
  BlockTypeRecord,
  FieldIssue,
  RevisionConflict,
  SlotRecord,
} from "../../services/content";
import type { User } from "../../services/users";

export interface SlotFormProps {
  user: User;
  /** The CSRF token bound to this form's POST. */
  formCsrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  slot: SlotRecord;
  blockType: BlockTypeRecord;
  content: Record<string, unknown>;
  /** The revision the editor loaded; null when the slot has none yet. */
  baseRevisionId: string | null;
  /** Fields present in the saved content but no longer published (Q4). */
  removedFieldNames: string[];
  /** The removed fields' values, carried through the save untouched. */
  removedContent: Record<string, unknown>;
  errors?: FieldIssue[];
  conflict?: RevisionConflict | null;
  saved?: boolean;
}

const formatWhen = (date: Date): string =>
  date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

export const SlotForm = ({
  user,
  formCsrfToken,
  navCsrfToken,
  slot,
  blockType,
  content,
  baseRevisionId,
  removedFieldNames,
  removedContent,
  errors,
  conflict,
  saved,
}: SlotFormProps) => (
  <Layout
    title={`${slot.label ?? slot.name} - Billet CMS`}
    name="cms"
    description="Edit a slot's content."
    canonicalPath={`/cms/slots/${slot.id}`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>{slot.page}</span>
    </p>
    <h1>{slot.label ?? slot.name}</h1>
    <p className="cms-slot-meta">
      Slot <code>{slot.name}</code> — block <code>{blockType.name}</code>
    </p>

    {saved && (
      <div className="flash-success" role="status">
        Draft saved.
      </div>
    )}

    {conflict && (
      <div className="flash-warning" role="alert">
        <p>
          Someone saved a newer version while this form was open
          {conflict.authorEmail ? ` (${conflict.authorEmail})` : ""}, at{" "}
          {formatWhen(conflict.createdAt)} UTC.
        </p>
        <p>
          Saving now will create another draft on top of theirs. Reload to see
          their version instead.
        </p>
      </div>
    )}

    {errors && errors.length > 0 && (
      <div className="flash-error" role="alert">
        <p>This content can't be saved:</p>
        <ul>
          {errors.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      </div>
    )}

    {removedFieldNames.length > 0 && (
      <div className="flash-warning" role="status">
        <p>
          These fields are no longer defined in code. Their saved values are
          kept as they are and cannot be edited here:
        </p>
        <ul>
          {removedFieldNames.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </div>
    )}

    <form method="POST" action={`/cms/slots/${slot.id}`} data-cms-form>
      <input type="hidden" name="_csrf" value={formCsrfToken} />
      {/* The whole document, so a save without JavaScript round-trips the
          stored content unchanged. The editor rebuilds this on submit. */}
      <input
        type="hidden"
        name="content"
        value={JSON.stringify(content)}
        data-cms-content
      />
      <input type="hidden" name="base_revision" value={baseRevisionId ?? ""} />
      {/* Removed fields are kept apart: the editor never touches this field, so
          their values survive even though they have no control (Q4). */}
      <input
        type="hidden"
        name="removed_fields"
        value={JSON.stringify(removedContent)}
      />
      {conflict && <input type="hidden" name="overwrite" value="1" />}

      <ContentFields fields={blockType.fields} content={content} />

      <button type="submit" className="cms-save">
        {conflict ? "Overwrite and save" : "Save draft"}
      </button>
    </form>

    <script type="module" src={getAssetUrl("/assets/cms-form.js")} />
  </Layout>
);

export interface SlotUnavailableProps {
  user: User;
  slot: SlotRecord;
  navCsrfToken?: string;
}

/** A slot whose block type is gone (Q4): flagged, not editable, not deleted. */
export const SlotUnavailable = ({
  user,
  slot,
  navCsrfToken,
}: SlotUnavailableProps) => (
  <Layout
    title={`${slot.name} - Billet CMS`}
    name="cms"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>{slot.page}</span>
    </p>
    <h1>{slot.label ?? slot.name}</h1>
    <div className="flash-warning" role="alert">
      The block type <code>{slot.blockName}</code> for this slot is no longer
      published. Its saved content is kept but cannot be edited until it is
      declared again.
    </div>
  </Layout>
);
