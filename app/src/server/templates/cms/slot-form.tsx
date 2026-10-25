import { ContentFields } from "../../components/cms/content-fields";
import {
  type FieldError,
  MediaOptionsTemplate,
} from "../../components/cms/field-control";
import { Layout } from "../../components/layouts";
import { getAssetUrl } from "../../services/assets";
import type {
  BlockTypeRecord,
  FieldIssue,
  RevisionConflict,
  SlotRecord,
} from "../../services/content";
import type { MediaOption } from "../../services/media";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";
import { humanise } from "../../utils/humanise";

/** A slot in an editor's words: its label, else its key humanised. */
const slotTitle = (slot: { label: string | null; name: string }) =>
  slot.label ?? humanise(slot.name);

export interface SlotFormProps {
  user: User;
  /** The CSRF token bound to this form's save POST. */
  formCsrfToken: string;
  /** The CSRF token bound to the publish POST. */
  publishCsrfToken: string;
  /** The CSRF token bound to the preview POST that mints a token. */
  previewCsrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  slot: SlotRecord;
  blockType: BlockTypeRecord;
  content: Record<string, unknown>;
  /** The revision the editor loaded; a conflict's revision once one was shown. */
  baseRevisionId: string | null;
  /** The newest revision, which is what Publish would make live. */
  latestRevisionId: string | null;
  /** The revision the site is currently rendering, when there is one. */
  publishedRevisionId: string | null;
  /** Fields present in the saved content but no longer published (Q4). */
  removedFieldNames: string[];
  /** The uploads an `image` field's picker offers, rendered once for the form. */
  media: MediaOption[];
  /** Whether that reuse list was capped, so the picker's help line is true. */
  pickerCapped: boolean;
  errors?: FieldIssue[];
  conflict?: RevisionConflict | null;
  /**
   * True when the errors came from a refused publish rather than a save, so the
   * banner names the action the editor took.
   */
  refusedPublish?: boolean;
  /** A one-line outcome from a save, publish or restore. */
  notice?: { kind: "success" | "warning"; message: string } | null;
}

/** The top-level field a dotted issue path points at: `gallery.0.mediaId` → `gallery`. */
const topLevelField = (path: string): string => path.split(".")[0];

export const SlotForm = ({
  user,
  formCsrfToken,
  publishCsrfToken,
  previewCsrfToken,
  navCsrfToken,
  slot,
  blockType,
  content,
  baseRevisionId,
  latestRevisionId,
  publishedRevisionId,
  removedFieldNames,
  media,
  pickerCapped,
  errors,
  conflict,
  refusedPublish,
  notice,
}: SlotFormProps) => {
  const labelFor = (name: string): string => {
    const field = blockType.fields.find((candidate) => candidate.name === name);
    return field?.label ?? field?.name ?? name;
  };

  // Whether there is something to publish, and what the last publish left live.
  // A publish is a no-op when the newest revision is already the published one,
  // so the button is disabled rather than allowed to churn the version counter.
  const hasDraft = latestRevisionId !== null;
  const upToDate =
    latestRevisionId !== null && latestRevisionId === publishedRevisionId;
  const publishStatus = !hasDraft
    ? "No draft saved yet."
    : upToDate
      ? "Published."
      : publishedRevisionId
        ? "Unpublished changes."
        : "Not published yet.";

  const errorsByField = new Map<string, FieldError[]>();
  for (const issue of errors ?? []) {
    const name = topLevelField(issue.path);
    const list = errorsByField.get(name) ?? [];
    list.push({ path: issue.path, message: issue.message });
    errorsByField.set(name, list);
  }

  return (
    <Layout
      title={`${slotTitle(slot)} - Billet CMS`}
      name="cms"
      description="Edit a slot's content."
      canonicalPath={`/cms/slots/${slot.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <p className="cms-breadcrumb">
        <a href="/cms">Content</a> / <span>{humanise(slot.page)}</span> /{" "}
        <span>{slotTitle(slot)}</span>
      </p>
      <h1>{slotTitle(slot)}</h1>
      <p className="cms-slot-meta">
        <code>{slot.name}</code> · block <code>{blockType.name}</code>
      </p>

      {slot.removedAt && (
        <div className="flash-warning" role="status">
          This slot is no longer declared in the site's templates. Its saved
          content is kept and can still be edited, but a deploy no longer
          renders it.
        </div>
      )}

      {notice && (
        <div
          className={
            notice.kind === "success" ? "flash-success" : "flash-warning"
          }
          role="status"
        >
          {notice.message}
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
            Saving now will create another draft on top of theirs.{" "}
            <a href={`/cms/slots/${slot.id}`}>Load their version</a> instead to
            start from what they saved.
          </p>
        </div>
      )}

      {errors && errors.length > 0 && (
        <div className="flash-error" role="alert">
          <p>
            {refusedPublish
              ? "This content can't be published. Check the fields marked below."
              : "This content can't be saved. Check the fields marked below."}
          </p>
          <ul>
            {errors.map((issue, index) => {
              const name = topLevelField(issue.path);
              const isField = blockType.fields.some(
                (candidate) => candidate.name === name,
              );
              return (
                <li key={`${issue.path}:${index}`}>
                  {isField && (
                    <>
                      <a href={`#cms-field-${name}`}>{labelFor(name)}</a>{" "}
                    </>
                  )}
                  {issue.message}
                </li>
              );
            })}
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
        {/* The reuse list, once for the form; each image picker is filled from
            it on focus rather than repeating it per field. */}
        <MediaOptionsTemplate media={media} />
        {/* The whole document, so a save without JavaScript round-trips the
            stored content unchanged. The editor rebuilds this on submit. */}
        <input
          type="hidden"
          name="content"
          value={JSON.stringify(content)}
          data-cms-content
        />
        {/* The revision the editor loaded. A save writes only when this is still
            the newest; a conflict re-renders this as the newer revision, so the
            next save is a deliberate overwrite of the version they saw. */}
        <input
          type="hidden"
          name="base_revision"
          value={baseRevisionId ?? ""}
        />

        <noscript>
          <p className="cms-noscript">
            Editing rich text and lists needs JavaScript. You can still save the
            stored content unchanged.
          </p>
        </noscript>

        <ContentFields
          fields={blockType.fields}
          content={content}
          errorsByField={errorsByField}
          hasMedia={media.length > 0}
          pickerCapped={pickerCapped}
        />

        <button type="submit" className="cms-save">
          {conflict ? "Overwrite and save" : "Save draft"}
        </button>
      </form>

      <section className="cms-actions" aria-label="Publishing">
        <p className="cms-publish-status" role="status">
          {publishStatus}
        </p>
        <form
          method="POST"
          action={`/cms/slots/${slot.id}/publish`}
          data-confirm="The site picks it up within seconds."
          data-confirm-title={`Publish '${slotTitle(slot)}'?`}
          data-confirm-label="Publish"
          data-confirm-danger="false"
        >
          <input type="hidden" name="_csrf" value={publishCsrfToken} />
          {/* The revision this form rendered. Publishing it — rather than the
              newest at submit time — is what makes a stale click a warning
              instead of someone else's draft going live unseen. */}
          <input type="hidden" name="revision" value={latestRevisionId ?? ""} />
          <button
            type="submit"
            className="cms-publish-button"
            disabled={!hasDraft || upToDate}
          >
            Publish
          </button>
        </form>
        {/* Preview mints a short-lived token and opens the slot's declared
            page on the site in a new tab, so the editor sees the draft inside
            the real page. Disabled with no draft, and when the draft is
            already the live revision: there is no unpublished change to
            preview. Matches Publish, which is disabled in the same two cases. */}
        <form
          method="POST"
          action={`/cms/slots/${slot.id}/preview`}
          target="_blank"
          rel="noopener"
        >
          <input type="hidden" name="_csrf" value={previewCsrfToken} />
          <button
            type="submit"
            className="cms-preview-button"
            disabled={!hasDraft || upToDate}
          >
            Preview draft <span aria-hidden="true">↗</span>
            <span className="sr-only">(opens in a new tab)</span>
          </button>
        </form>
        <a className="cms-history-link" href={`/cms/slots/${slot.id}/history`}>
          History
        </a>
      </section>

      <script type="module" src={getAssetUrl("/assets/cms-form.js")} />
    </Layout>
  );
};

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
    title={`${slotTitle(slot)} - Billet CMS`}
    name="cms"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>{humanise(slot.page)}</span> /{" "}
      <span>{slotTitle(slot)}</span>
    </p>
    <h1>{slotTitle(slot)}</h1>
    <div className="flash-warning" role="alert">
      The block type <code>{slot.blockName}</code> for this slot is no longer
      published. Its saved content is kept but cannot be edited until it is
      declared again.
    </div>
  </Layout>
);
