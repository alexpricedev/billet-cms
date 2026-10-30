import { ContentFields } from "../../components/cms/content-fields";
import {
  type FieldError,
  MediaOptionsTemplate,
} from "../../components/cms/field-control";
import { Flash, type FlashField } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import { getAssetUrl } from "../../services/assets";
import type {
  BlockTypeRecord,
  FieldIssue,
  RevisionConflict,
  SlotRecord,
} from "../../services/content";
import type { MediaOption } from "../../services/media";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";
import { humanise } from "../../utils/humanise";
import {
  previewReason,
  publishReason,
  publishStatusLine,
} from "../../utils/publish-status";
import { slotTitle } from "../../utils/slot-title";

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
  /** When that revision was saved, for the status line. */
  latestRevisionAt: Date | null;
  /** The revision the site is currently rendering, when there is one. */
  publishedRevisionId: string | null;
  /** When the live revision was saved, for the status line. */
  publishedRevisionAt: Date | null;
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
  latestRevisionAt,
  publishedRevisionId,
  publishedRevisionAt,
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
  // Publish is the committing action only when it would actually do something;
  // otherwise it is a greyed secondary button with a reason beside it.
  const canPublish = hasDraft && !upToDate;
  const status = publishStatusLine({
    latestRevisionAt,
    upToDate,
    published: publishedRevisionId !== null,
    publishedRevisionAt,
  });
  const publishWhy = publishReason(hasDraft, upToDate);
  const previewWhy = previewReason(hasDraft, upToDate);

  const errorsByField = new Map<string, FieldError[]>();
  for (const issue of errors ?? []) {
    const name = topLevelField(issue.path);
    const list = errorsByField.get(name) ?? [];
    list.push({ path: issue.path, message: issue.message });
    errorsByField.set(name, list);
  }

  // The error banner links each invalid field once, to the control it belongs
  // to. An issue outside the block's fields (`(content)`, `(form)`) has no
  // control to reach, so it keeps its own message as plain text.
  const issueFields: FlashField[] = [];
  const seenIssueFields = new Set<string>();
  for (const issue of errors ?? []) {
    const name = topLevelField(issue.path);
    if (!blockType.fields.some((candidate) => candidate.name === name)) {
      issueFields.push({ label: issue.message });
      continue;
    }
    const id = `cms-field-${name}`;
    if (seenIssueFields.has(id)) continue;
    seenIssueFields.add(id);
    issueFields.push({ id, label: labelFor(name) });
  }
  const fieldIssueCount = seenIssueFields.size;
  const fixLine =
    fieldIssueCount === 0
      ? undefined
      : fieldIssueCount === 1
        ? "Fix this field and try again:"
        : `Fix these ${fieldIssueCount} fields and try again:`;

  return (
    <Layout
      title={`${slotTitle(slot)} - ${SITE_NAME}`}
      name="cms"
      description="Edit a slot's content."
      canonicalPath={`/cms/slots/${slot.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <PageHeader
        breadcrumb={
          <>
            <a href="/cms">Content</a> / <span>{humanise(slot.page)}</span> /{" "}
            <span>{slotTitle(slot)}</span>
          </>
        }
        title={slotTitle(slot)}
        after={
          <p className="cms-slot-meta">
            <code>{slot.name}</code> · block <code>{blockType.name}</code>
          </p>
        }
      />

      {slot.removedAt && (
        <Flash
          tone="warning"
          title="This slot is no longer declared in the site's templates. Its saved content is kept and can still be edited, but a deploy no longer renders it."
        />
      )}

      {notice && (
        <Flash tone={notice.kind} title={notice.message} dismissible />
      )}

      {conflict && (
        <Flash
          tone="warning"
          title={
            <>
              Someone saved a newer version while this form was open
              {conflict.authorEmail ? ` (${conflict.authorEmail})` : ""}, at{" "}
              {formatWhen(conflict.createdAt)} UTC.
            </>
          }
          detail={
            <>
              Saving now will create another draft on top of theirs.{" "}
              <a href={`/cms/slots/${slot.id}`}>Load their version</a> instead
              to start from what they saved.
            </>
          }
          dismissible
        />
      )}

      {errors && errors.length > 0 && (
        <Flash
          tone="error"
          title={refusedPublish ? "Couldn't publish." : "Couldn't save draft."}
          detail={fixLine}
          fields={issueFields}
          dismissible
        />
      )}

      {removedFieldNames.length > 0 && (
        <Flash
          tone="warning"
          title="These fields are no longer defined in code."
          detail="Their saved values are kept as they are and cannot be edited here:"
        >
          <ul className="flash-fields">
            {removedFieldNames.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </Flash>
      )}

      <form
        id="cms-slot-form"
        method="POST"
        action={`/cms/slots/${slot.id}`}
        className="cms-slot-form"
        data-cms-form
      >
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
        {/* Set by the editor when a save is what stands between them and the
            preview they asked for, so the redirect can bring them back to it.
            Empty on an ordinary save, and ignored without JavaScript. */}
        <input type="hidden" name="after" value="" data-save-after />

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
          media={media}
        />
      </form>

      {/* The status line and the disabled-button reasons are the bar's own
          persistent state and help text, not event notices: they render on
          every load and are never dismissible, so they stay out of Flash. */}
      <section className="cms-actions" aria-label="Publishing">
        <p className="cms-publish-status" role="status">
          {status}
        </p>
        <div className="cms-action-buttons">
          {/* Outside the save form so the bar can be sticky and hold every
              action, but still a submit of it: `form` is what keeps Enter in a
              field saving, and the preview guard's `requestSubmit` working. */}
          <button
            type="submit"
            form="cms-slot-form"
            className={`cms-save btn ${canPublish ? "btn-secondary" : "btn-primary"}`}
          >
            {conflict ? "Overwrite and save" : "Save draft"}
          </button>
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
            <input
              type="hidden"
              name="revision"
              value={latestRevisionId ?? ""}
            />
            <button
              type="submit"
              className={`cms-publish-button btn ${canPublish ? "btn-primary" : "btn-secondary"}`}
              disabled={!canPublish}
              aria-describedby={publishWhy ? "publish-reason" : undefined}
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
              className="cms-preview-button btn btn-secondary"
              disabled={!canPublish}
              aria-describedby={previewWhy ? "preview-reason" : undefined}
              data-preview-submit
            >
              Preview draft <span aria-hidden="true">↗</span>
              <span className="sr-only">(opens in a new tab)</span>
            </button>
          </form>
          <a
            className="cms-history-link btn btn-ghost"
            href={`/cms/slots/${slot.id}/history`}
          >
            History
          </a>
        </div>
        {(publishWhy || previewWhy) && (
          <p className="cms-action-reason">
            {publishWhy && <span id="publish-reason">{publishWhy}</span>}
            {publishWhy && previewWhy && " "}
            {previewWhy && <span id="preview-reason">{previewWhy}</span>}
          </p>
        )}
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
    title={`${slotTitle(slot)} - ${SITE_NAME}`}
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
    <Flash
      tone="warning"
      title={
        <>
          The block type <code>{slot.blockName}</code> for this slot is no
          longer published. Its saved content is kept but cannot be edited until
          it is declared again.
        </>
      }
    />
  </Layout>
);
