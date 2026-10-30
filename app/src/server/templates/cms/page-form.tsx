import type { JSX } from "preact";
import type { FieldError } from "../../components/cms/field-control";
import { MediaOptionsTemplate } from "../../components/cms/field-control";
import { Flash, type FlashField } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import { getAssetUrl } from "../../services/assets";
import type {
  BlockTypeRecord,
  FieldIssue,
  PageBlock,
  PageOption,
  PageRecord,
  PageSettingsInput,
  PageTypeRecord,
  RevisionConflict,
  UnavailableBlock,
} from "../../services/content";
import { normalisePageUrl } from "../../services/content/pages";
import type { MediaOption } from "../../services/media";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";
import {
  previewReason,
  publishReason,
  publishStatusLine,
} from "../../utils/publish-status";
import { PageBlocks } from "./page-blocks";

export interface PageFormProps {
  user: User;
  /** The CSRF token bound to the save POST. */
  formCsrfToken: string;
  /** The CSRF token bound to the publish POST. */
  publishCsrfToken: string;
  /** The CSRF token bound to the preview POST that mints a token. */
  previewCsrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  page: PageRecord;
  pageTypes: PageTypeRecord[];
  pageType: PageTypeRecord | null;
  blockTypes: BlockTypeRecord[];
  content: PageBlock[];
  unavailable: UnavailableBlock[];
  /** The revision the editor loaded; a conflict's revision once one was shown. */
  baseRevisionId: string | null;
  /**
   * Base-revision indices of flagged blocks the editor removed. Re-rendered so
   * a failed save keeps the removal (review round 2).
   */
  removed?: number[];
  /** The newest revision, which is what Publish would make live. */
  latestRevisionId: string | null;
  /** When that revision was saved, for the status line. */
  latestRevisionAt: Date | null;
  /** The revision the site is currently rendering, when there is one. */
  publishedRevisionId: string | null;
  /** When the live revision was saved, for the status line. */
  publishedRevisionAt: Date | null;
  pages: PageOption[];
  /** The uploads an `image` field's picker offers, rendered once for the form. */
  media: MediaOption[];
  /** Whether the reuse list was capped, so the picker's help line is true. */
  pickerCapped: boolean;
  /** Validation messages for the settings fields, keyed by field name. */
  settingsErrors?: Map<string, FieldError[]>;
  /** Validation messages for a block's fields, keyed by the block's index. */
  blockErrors?: Map<number, Map<string, FieldError[]>>;
  /**
   * Whole-block messages (the hero-first rule, the rich-text nesting bound),
   * keyed by the block's index. Shown on the block itself, and linked to from
   * the banner's summary line.
   */
  blockAlerts?: Map<number, string>;
  /** Every content issue, shown as a list above the blocks. */
  contentIssues?: FieldIssue[];
  conflict?: RevisionConflict | null;
  /**
   * True when the issues came from a refused publish rather than a save, so the
   * banner names the action the editor took.
   */
  refusedPublish?: boolean;
  notice?: {
    kind: "success" | "warning";
    message: string;
    /** A second line, e.g. how many empty blocks a save removed. */
    detail?: string;
  } | null;
  /**
   * The settings to show in the fields. Defaults to the page's stored settings;
   * a failed save passes what the editor typed so their input isn't discarded.
   */
  values?: PageSettingsInput & { pageType: string };
}

/**
 * One line in the error banner's list.
 *
 * An issue at `blocks.N` rather than `blocks.N.field` has no control to mark —
 * the hero-first rule and the rich text nesting bound are the two that land
 * there — so it names the block (position and type) and links to the block,
 * which at 390 sits several screens below the banner (review round 2). A field
 * issue links to the control the field renders, whose anchor is the block's id
 * prefix plus the field name. Anything else, or a block that isn't on the page,
 * has nothing to link to and stays plain text.
 */
const contentIssueField = (
  issue: FieldIssue,
  blocks: PageBlock[],
  blockTypes: BlockTypeRecord[],
): FlashField => {
  const match = /^blocks\.(\d+)(?:\.(.+))?$/.exec(issue.path);
  if (!match) return { label: issue.message };
  const index = Number(match[1]);
  const block = blocks[index];
  const type = block?.type;
  if (typeof type !== "string" || type === "") return { label: issue.message };
  if (match[2] === undefined) {
    const summary = `Block ${index + 1} (${type}): ${issue.message}`;
    // A block the page type doesn't render as a card has no anchor to reach,
    // so the line stays plain text rather than being a link to nowhere.
    return index >= blocks.length
      ? { label: summary }
      : { id: `block-${index + 1}`, label: summary };
  }
  const field = match[2].split(".")[0];
  const definition = blockTypes.find((candidate) => candidate.name === type);
  const label =
    definition?.fields.find((candidate) => candidate.name === field)?.label ??
    field;
  return { id: `cms-block-${index}-${type}-${field}`, label };
};

const SettingsControl = ({
  name,
  label,
  help,
  value,
  errors,
  required,
  textarea,
  live,
  extra,
}: {
  name: string;
  label: string;
  help?: string;
  value: string;
  errors?: FieldError[];
  required?: boolean;
  textarea?: boolean;
  /** The stored value, so the client can tell when the input differs. */
  live?: string;
  /** A line under the field the editor's input can toggle; `id` is described. */
  extra?: { id: string; node: JSX.Element };
}) => {
  const invalid = errors !== undefined && errors.length > 0;
  const helpId = `${name}-help`;
  const errorId = `${name}-error`;
  const described = [
    help ? helpId : null,
    invalid ? errorId : null,
    extra?.id ?? null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="cms-field" data-field-kind="setting">
      <label className="cms-field-label" htmlFor={name}>
        {label}
        {required && <span className="cms-required"> *</span>}
      </label>
      {textarea ? (
        <textarea
          id={name}
          name={name}
          rows={3}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={described || undefined}
        >
          {value}
        </textarea>
      ) : (
        <input
          type="text"
          id={name}
          name={name}
          value={value}
          data-url-live={live}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={described || undefined}
        />
      )}
      {invalid && (
        <ul className="cms-field-errors" id={errorId}>
          {errors?.map((error, index) => (
            <li key={`${error.path}:${index}`}>{error.message}</li>
          ))}
        </ul>
      )}
      {help && (
        <span className="cms-field-help" id={helpId}>
          {help}
        </span>
      )}
      {extra?.node}
    </div>
  );
};

/**
 * The page editor: the page's settings, its blocks, and publishing alongside.
 *
 * Settings are live columns (a title, an SEO description, a social image) —
 * except the URL, which is stored with the draft and moves on Publish, like the
 * content in `cms_revisions`. One save writes both, so the URL a redirect is
 * written for is the one the editor can see, and the content the site will
 * render is the one they just looked at.
 */
export const PageForm = ({
  user,
  formCsrfToken,
  publishCsrfToken,
  previewCsrfToken,
  navCsrfToken,
  page,
  pageTypes,
  pageType,
  blockTypes,
  content,
  unavailable,
  baseRevisionId,
  removed,
  latestRevisionId,
  latestRevisionAt,
  publishedRevisionId,
  publishedRevisionAt,
  pages,
  media,
  pickerCapped,
  settingsErrors,
  blockErrors,
  blockAlerts,
  contentIssues,
  conflict,
  refusedPublish,
  notice,
  values,
}: PageFormProps) => {
  const settings = values ?? {
    pageType: page.pageType,
    // A saved address change waits for Publish, so the field shows the draft.
    url: page.draftUrl ?? page.url,
    title: page.title,
    seoDescription: page.seoDescription,
    socialImage: page.socialImage,
  };
  const hasDraft = latestRevisionId !== null;
  const upToDate =
    latestRevisionId !== null && latestRevisionId === publishedRevisionId;
  const canPublish = hasDraft && !upToDate;
  const status = publishStatusLine({
    latestRevisionAt,
    upToDate,
    published: publishedRevisionId !== null,
    publishedRevisionAt,
  });
  const publishWhy = publishReason(hasDraft, upToDate);
  const previewWhy = previewReason(hasDraft, upToDate);

  // Only a saved draft URL that differs from the live one will redirect on
  // Publish. Earlier moves' redirects are already live and are not mentioned.
  const publishMessage = `The site picks it up within seconds.${
    page.draftUrl !== null && page.draftUrl !== page.url
      ? ` The old address ${page.url} will redirect to ${page.draftUrl}.`
      : ""
  }`;

  // The field starts at the stored address — the draft if one is pending — and
  // the warning compares what is typed with the *live* address, because that is
  // what Publish would move.
  const typedUrl = normalisePageUrl(settings.url);
  const storedUrl = page.draftUrl ?? page.url;
  const moving = typedUrl.ok ? typedUrl.url !== page.url : false;
  const movingTo = typedUrl.ok ? typedUrl.url : settings.url;
  // A saved draft URL sits in the breadcrumb beside the live one; anything
  // typed on top of it is a second, unsaved value.
  const draftPending = page.draftUrl !== null && page.draftUrl !== page.url;
  const unsaved = typedUrl.ok
    ? typedUrl.url !== storedUrl
    : settings.url.trim() !== storedUrl;

  const uneditable = pageType === null;

  // The error banner lists every issue: a field links to its control, a whole
  // block links to the block, and an issue with neither (a page-limit rule, an
  // unreadable body) keeps its own message. The "Fix these N fields" line only
  // counts real fields — a whole-block issue has no field to fix, and telling
  // the editor to check marked blocks that aren't marked was the review-round-1
  // failure.
  const issueFields: FlashField[] = [];
  const seenIssueFields = new Set<string>();
  for (const issue of contentIssues ?? []) {
    const field = contentIssueField(issue, content, blockTypes);
    if (field.id?.startsWith("cms-block-")) {
      if (seenIssueFields.has(field.id)) continue;
      seenIssueFields.add(field.id);
    }
    issueFields.push(field);
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
      title={`${page.title} - ${SITE_NAME}`}
      name="cms"
      description="Edit a page's content and settings."
      canonicalPath={`/cms/pages/${page.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <PageHeader
        breadcrumb={
          <>
            <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
            <span>{page.url}</span>
            {draftPending && (
              <>
                {" "}
                <span>
                  <code>{page.draftUrl}</code> (not published)
                </span>
              </>
            )}
            {unsaved && (
              <>
                {" "}
                <span>(unsaved: {settings.url})</span>
              </>
            )}
          </>
        }
        title={page.title}
      />

      {notice && (
        <Flash
          tone={notice.kind}
          title={notice.message}
          detail={notice.detail}
          dismissible
        />
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
              <a href={`/cms/pages/${page.id}`}>Load their version</a> instead
              to start from what they saved.
            </>
          }
          dismissible
        />
      )}

      {uneditable && (
        <>
          <Flash
            tone="warning"
            title={
              <>
                The page type <code>{page.pageType}</code> is no longer
                published, so this page can't be edited until it is declared
                again. Its content is kept.
              </>
            }
          />
          {/* The form and its settings don't render without a page type, so
              the page's only remaining action sits here, under the warning. */}
          <a
            className="cms-delete-button"
            href={`/cms/pages/${page.id}/delete`}
          >
            Delete page
          </a>
        </>
      )}

      {contentIssues && contentIssues.length > 0 && (
        <Flash
          tone="error"
          title={refusedPublish ? "Couldn't publish." : "Couldn't save draft."}
          detail={fixLine}
          fields={issueFields}
          dismissible
        />
      )}

      {!uneditable && (
        <form
          id="cms-page-form"
          method="POST"
          action={`/cms/pages/${page.id}`}
          className="cms-page-form"
          data-cms-form
        >
          <input type="hidden" name="_csrf" value={formCsrfToken} />
          {/* The reuse list, once for the form; each image picker is filled
              from it on focus rather than repeating it per field. */}
          <MediaOptionsTemplate media={media} />
          {/* The whole document, so a save without JavaScript round-trips the
              stored content unchanged. The editor rebuilds this on submit. */}
          <input
            type="hidden"
            name="content"
            value={JSON.stringify({ blocks: content })}
            data-cms-content
          />
          <input
            type="hidden"
            name="base_revision"
            value={baseRevisionId ?? ""}
          />
          {/* Set by the editor when a save is what stands between them and the
              preview they asked for, so the redirect can bring them back to
              it. Empty on an ordinary save, and ignored without JavaScript. */}
          <input type="hidden" name="after" value="" data-save-after />
          {/* Flagged blocks the editor removed, by base-revision index. The
              client appends to this as Remove is pressed; re-rendered here so
              a failed save keeps the removal. */}
          <input
            type="hidden"
            name="removed_blocks"
            value={(removed ?? []).join(",")}
            data-cms-removed
          />
          {/* The types of empty blocks the client left out of the content, so
              the saved notice can say so. Always empty on render. */}
          <input
            type="hidden"
            name="dropped_blocks"
            value=""
            data-cms-dropped
          />

          <div className="editor-layout">
            <section className="cms-page-content-section" aria-label="Blocks">
              <h2>Blocks</h2>
              <noscript>
                <p className="cms-noscript">
                  Editing rich text, lists and blocks needs JavaScript. You can
                  still save the stored content unchanged.
                </p>
              </noscript>
              {pageType ? (
                <PageBlocks
                  pageType={pageType}
                  blockTypes={blockTypes}
                  blocks={content}
                  unavailable={unavailable}
                  errorsByBlock={blockErrors}
                  alertsByBlock={blockAlerts}
                  pages={pages}
                  hasMedia={media.length > 0}
                  pickerCapped={pickerCapped}
                  media={media}
                />
              ) : (
                <p className="cms-blocks-empty">
                  The page type isn't published, so its blocks can't be edited.
                </p>
              )}
            </section>

            <section className="cms-page-settings" aria-label="Page settings">
              <h2>Settings</h2>
              <div className="cms-field" data-field-kind="setting">
                <label className="cms-field-label" htmlFor="pageType">
                  Page type
                </label>
                <select
                  id="pageType"
                  name="pageType"
                  aria-invalid={
                    settingsErrors?.get("pageType") ? "true" : undefined
                  }
                  aria-describedby={
                    settingsErrors?.get("pageType")
                      ? "pageType-error"
                      : undefined
                  }
                >
                  {pageTypes
                    .filter(
                      (candidate) =>
                        candidate.removedAt === null ||
                        candidate.name === settings.pageType,
                    )
                    .map((candidate) => (
                      <option
                        value={candidate.name}
                        key={candidate.id}
                        selected={candidate.name === settings.pageType}
                      >
                        {candidate.label ?? candidate.name}
                      </option>
                    ))}
                  {/* A page whose type a deploy removed still has to show its
                    current type rather than silently switching on save. */}
                  {pageTypes.every(
                    (candidate) => candidate.name !== settings.pageType,
                  ) && (
                    <option value={settings.pageType}>
                      {settings.pageType}
                    </option>
                  )}
                </select>
                {settingsErrors?.get("pageType") && (
                  <ul className="cms-field-errors" id="pageType-error">
                    {settingsErrors.get("pageType")?.map((error, index) => (
                      <li key={`${error.path}:${index}`}>{error.message}</li>
                    ))}
                  </ul>
                )}
              </div>
              <SettingsControl
                name="url"
                label="URL"
                help="The path the page is served at, e.g. /company."
                value={settings.url}
                errors={settingsErrors?.get("url")}
                required
                live={page.url}
                extra={{
                  id: "url-move",
                  node: (
                    <p
                      className="cms-field-help cms-url-move"
                      id="url-move"
                      data-url-move
                      hidden={!moving}
                    >
                      <span aria-hidden="true">⚠ </span>
                      {publishedRevisionId !== null ? (
                        <>
                          Publishing moves this page: <code>{page.url}</code>{" "}
                          will redirect to{" "}
                          <code data-url-move-to>{movingTo}</code>.
                        </>
                      ) : (
                        // A page that has never been published has nothing live
                        // to protect, so its address moves on Save — no
                        // redirect, and no waiting for Publish.
                        <>
                          Saving moves this page to{" "}
                          <code data-url-move-to>{movingTo}</code>.
                        </>
                      )}
                    </p>
                  ),
                }}
              />
              <SettingsControl
                name="title"
                label="Title"
                value={settings.title}
                errors={settingsErrors?.get("title")}
                required
              />
              <SettingsControl
                name="seoDescription"
                label="SEO description"
                help="Used for the meta description and social cards."
                value={settings.seoDescription ?? ""}
                errors={settingsErrors?.get("seoDescription")}
                textarea
              />
              <SettingsControl
                name="socialImage"
                label="Social image URL"
                help="An absolute or site-relative image URL for social cards."
                value={settings.socialImage ?? ""}
                errors={settingsErrors?.get("socialImage")}
              />
              {/* Deleting goes through a confirm step that names the page, its
                  redirects and the pages linking to it, rather than deleting
                  on one click. It is a link, not a submit: the save payload
                  doesn't change. */}
              <a
                className="cms-delete-button"
                href={`/cms/pages/${page.id}/delete`}
              >
                Delete page
              </a>
            </section>
          </div>
        </form>
      )}

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
          {!uneditable && (
            <button
              type="submit"
              form="cms-page-form"
              className={`cms-save btn ${canPublish ? "btn-secondary" : "btn-primary"}`}
            >
              {conflict ? "Overwrite and save" : "Save draft"}
            </button>
          )}
          <form
            method="POST"
            action={`/cms/pages/${page.id}/publish`}
            data-confirm={publishMessage}
            data-confirm-title={`Publish '${page.title}'?`}
            data-confirm-label="Publish"
            data-confirm-danger="false"
          >
            <input type="hidden" name="_csrf" value={publishCsrfToken} />
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
          {/* Preview mints a short-lived token and opens the site in a new tab
              with it, so the editor sees the draft without leaving the CMS.
              Disabled with no draft, and when the draft is already the live
              revision: there is no unpublished change to preview. Matches
              Publish, which is disabled in the same two cases. */}
          <form
            method="POST"
            action={`/cms/pages/${page.id}/preview`}
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
            href={`/cms/pages/${page.id}/history`}
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

      {!uneditable && (
        <script type="module" src={getAssetUrl("/assets/cms-form.js")} />
      )}
    </Layout>
  );
};

export interface NewPageFormProps {
  user: User;
  csrfToken: string;
  navCsrfToken?: string;
  pageTypes: PageTypeRecord[];
  values: {
    pageType: string;
    url: string;
    title: string;
    seoDescription: string;
    socialImage: string;
  };
  errors?: FieldError[];
}

/** The create form: a page type and the settings it starts with. */
export const NewPageForm = ({
  user,
  csrfToken,
  navCsrfToken,
  pageTypes,
  values,
  errors,
}: NewPageFormProps) => {
  const errorsByField = new Map<string, FieldError[]>();
  for (const error of errors ?? []) {
    const list = errorsByField.get(error.path) ?? [];
    list.push(error);
    errorsByField.set(error.path, list);
  }

  return (
    <Layout
      title={`New page - ${SITE_NAME}`}
      name="cms"
      description="Create a page."
      canonicalPath="/cms/pages/new"
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <PageHeader
        breadcrumb={
          <>
            <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
            <span>New</span>
          </>
        }
        title="New page"
        description="Pick a page type, then choose the URL, title and SEO settings. You'll add blocks on the next screen, and nothing goes live until you publish."
      />

      {pageTypes.length === 0 ? (
        <Flash
          tone="warning"
          title="No page types are published yet."
          detail="Deploy the site, or check that its publish step ran against this database."
        />
      ) : (
        <form
          method="POST"
          action="/cms/pages/new"
          className="cms-page-form cms-new-page-form"
        >
          <input type="hidden" name="_csrf" value={csrfToken} />
          <div className="cms-field" data-field-kind="setting">
            <label className="cms-field-label" htmlFor="pageType">
              Page type
              <span className="cms-required"> *</span>
            </label>
            <select
              id="pageType"
              name="pageType"
              aria-invalid={errorsByField.get("pageType") ? "true" : undefined}
              aria-describedby={
                errorsByField.get("pageType") ? "pageType-error" : undefined
              }
            >
              {pageTypes
                .filter((candidate) => candidate.removedAt === null)
                .map((candidate) => (
                  <option
                    value={candidate.name}
                    key={candidate.id}
                    selected={candidate.name === values.pageType}
                  >
                    {candidate.label ?? candidate.name}
                  </option>
                ))}
            </select>
            {errorsByField.get("pageType") && (
              <ul className="cms-field-errors" id="pageType-error">
                {errorsByField.get("pageType")?.map((error, index) => (
                  <li key={`${error.path}:${index}`}>{error.message}</li>
                ))}
              </ul>
            )}
          </div>
          <SettingsControl
            name="url"
            label="URL"
            help="The path the page is served at, e.g. /company."
            value={values.url}
            errors={errorsByField.get("url")}
            required
          />
          <SettingsControl
            name="title"
            label="Title"
            value={values.title}
            errors={errorsByField.get("title")}
            required
          />
          <SettingsControl
            name="seoDescription"
            label="SEO description"
            help="Used for the meta description and social cards."
            value={values.seoDescription}
            errors={errorsByField.get("seoDescription")}
            textarea
          />
          <SettingsControl
            name="socialImage"
            label="Social image URL"
            help="An absolute or site-relative image URL for social cards."
            value={values.socialImage}
            errors={errorsByField.get("socialImage")}
          />
          <button type="submit" className="cms-save btn btn-primary">
            Create page
          </button>
        </form>
      )}
    </Layout>
  );
};

export interface PageUnavailableProps {
  user: User;
  page: PageRecord;
  navCsrfToken?: string;
}

/** A page whose page type a deploy removed: flagged, read-only, kept. */
export const PageUnavailable = ({
  user,
  page,
  navCsrfToken,
}: PageUnavailableProps) => (
  <Layout
    title={`${page.title} - ${SITE_NAME}`}
    name="cms"
    description="A page that can't be edited."
    canonicalPath={`/cms/pages/${page.id}`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <span>{page.url}</span>
        </>
      }
      title={page.title}
    />
    <Flash
      tone="warning"
      title={
        <>
          The page type <code>{page.pageType}</code> is no longer published.
          This page's content is kept but cannot be edited until it is declared
          again.
        </>
      }
    />
    {/* Without a published type there is no form and no settings box, so the
        page's only remaining action sits here, under the warning. */}
    <a className="cms-delete-button" href={`/cms/pages/${page.id}/delete`}>
      Delete page
    </a>
  </Layout>
);
