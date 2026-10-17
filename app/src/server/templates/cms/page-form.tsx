import type { FieldError } from "../../components/cms/field-control";
import { MediaOptionsTemplate } from "../../components/cms/field-control";
import { Layout } from "../../components/layouts";
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
import type { MediaOption } from "../../services/media";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";
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
  /** The revision the site is currently rendering, when there is one. */
  publishedRevisionId: string | null;
  pages: PageOption[];
  /** The uploads an `image` field's picker offers, rendered once for the form. */
  media: MediaOption[];
  /** Whether the reuse list was capped, so the picker's help line is true. */
  pickerCapped: boolean;
  /** Validation messages for the settings fields, keyed by field name. */
  settingsErrors?: Map<string, FieldError[]>;
  /** Validation messages for a block's fields, keyed by the block's index. */
  blockErrors?: Map<number, Map<string, FieldError[]>>;
  /** Every content issue, shown as a list above the blocks. */
  contentIssues?: FieldIssue[];
  conflict?: RevisionConflict | null;
  /**
   * True when the issues came from a refused publish rather than a save, so the
   * banner names the action the editor took.
   */
  refusedPublish?: boolean;
  notice?: { kind: "success" | "warning"; message: string } | null;
  /**
   * The settings to show in the fields. Defaults to the page's stored settings;
   * a failed save passes what the editor typed so their input isn't discarded.
   */
  values?: PageSettingsInput & { pageType: string };
}

/**
 * A whole-block issue's summary line, worded so the editor knows which block.
 *
 * An issue at `blocks.N` rather than `blocks.N.field` has no control to mark —
 * the rich text nesting bound is the one the editor can reach — so without a
 * block name on the summary line, a page with several blocks gives no clue
 * which one the message is about (review round 2).
 */
const blockSummaryMessage = (issue: FieldIssue): string => {
  const match = /^blocks\.(\d+)$/.exec(issue.path);
  return match
    ? `Block ${Number(match[1]) + 1}: ${issue.message}`
    : issue.message;
};

const SettingsControl = ({
  name,
  label,
  help,
  value,
  errors,
  required,
  textarea,
}: {
  name: string;
  label: string;
  help?: string;
  value: string;
  errors?: FieldError[];
  required?: boolean;
  textarea?: boolean;
}) => {
  const invalid = errors !== undefined && errors.length > 0;
  const helpId = `${name}-help`;
  const errorId = `${name}-error`;
  const described = [help ? helpId : null, invalid ? errorId : null]
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
    </div>
  );
};

/**
 * The page editor: the page's settings, its blocks, and publishing alongside.
 *
 * Settings are live columns (a URL, a title, an SEO description, a social
 * image); content is versioned in `cms_revisions`. One save writes both, so the
 * URL a redirect is written for is the one the editor can see, and the content
 * the site will render is the one they just looked at.
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
  publishedRevisionId,
  pages,
  media,
  pickerCapped,
  settingsErrors,
  blockErrors,
  contentIssues,
  conflict,
  refusedPublish,
  notice,
  values,
}: PageFormProps) => {
  const settings = values ?? {
    pageType: page.pageType,
    url: page.url,
    title: page.title,
    seoDescription: page.seoDescription,
    socialImage: page.socialImage,
  };
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

  const uneditable = pageType === null;
  // Whether a block below carries a field error. A limit issue (`blocks`) or an
  // unreadable body (`(content)`) has no block to point at, so the banner must
  // not tell the editor to look at blocks that aren't marked (review round 1).
  const hasBlockErrors = (blockErrors?.size ?? 0) > 0;

  return (
    <Layout
      title={`${page.title} - Billet CMS`}
      name="cms"
      description="Edit a page's content and settings."
      canonicalPath={`/cms/pages/${page.id}`}
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <p className="cms-breadcrumb">
        <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
        <span>{page.url}</span>
      </p>
      <h1>{page.title}</h1>

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
            <a href={`/cms/pages/${page.id}`}>Load their version</a> instead to
            start from what they saved.
          </p>
        </div>
      )}

      {uneditable && (
        <div className="flash-warning" role="alert">
          The page type <code>{page.pageType}</code> is no longer published, so
          this page can't be edited until it is declared again. Its content is
          kept.
        </div>
      )}

      {contentIssues && contentIssues.length > 0 && (
        <div className="flash-error" role="alert">
          <p>
            {refusedPublish
              ? "This content can't be published."
              : "This content can't be saved."}
            {hasBlockErrors ? " Check the blocks marked below." : ""}
          </p>
          <ul>
            {contentIssues.map((issue, index) => (
              <li key={`${issue.path}:${index}`}>
                {blockSummaryMessage(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!uneditable && (
        <form
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
          {/* Flagged blocks the editor removed, by base-revision index. The
              client appends to this as Remove is pressed; re-rendered here so
              a failed save keeps the removal. */}
          <input
            type="hidden"
            name="removed_blocks"
            value={(removed ?? []).join(",")}
            data-cms-removed
          />

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
                  settingsErrors?.get("pageType") ? "pageType-error" : undefined
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
                  <option value={settings.pageType}>{settings.pageType}</option>
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
              help="The path the page is served at, e.g. /about."
              value={settings.url}
              errors={settingsErrors?.get("url")}
              required
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
          </section>

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
                pages={pages}
                hasMedia={media.length > 0}
                pickerCapped={pickerCapped}
              />
            ) : (
              <p className="cms-blocks-empty">
                The page type isn't published, so its blocks can't be edited.
              </p>
            )}
          </section>

          <button type="submit" className="cms-save">
            {conflict ? "Overwrite and save" : "Save draft"}
          </button>
        </form>
      )}

      <section className="cms-actions" aria-label="Publishing">
        <p className="cms-publish-status" role="status">
          {publishStatus}
        </p>
        <form method="POST" action={`/cms/pages/${page.id}/publish`}>
          <input type="hidden" name="_csrf" value={publishCsrfToken} />
          <input type="hidden" name="revision" value={latestRevisionId ?? ""} />
          <button
            type="submit"
            className="cms-publish-button"
            disabled={!hasDraft || upToDate}
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
            className="cms-preview-button"
            disabled={!hasDraft || upToDate}
          >
            Preview draft <span aria-hidden="true">↗</span>
            <span className="sr-only">(opens in a new tab)</span>
          </button>
        </form>
        <a className="cms-history-link" href={`/cms/pages/${page.id}/history`}>
          History
        </a>
      </section>

      <section className="cms-danger" aria-label="Delete">
        {/* Deleting goes through a confirm step that names the page, its
            redirects and the pages linking to it, rather than deleting on one
            click. */}
        <a className="cms-delete-button" href={`/cms/pages/${page.id}/delete`}>
          Delete page
        </a>
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
      title="New page - Billet CMS"
      name="cms"
      description="Create a page."
      canonicalPath="/cms/pages/new"
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <p className="cms-breadcrumb">
        <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
        <span>New</span>
      </p>
      <h1>New page</h1>
      <p className="cms-intro">
        Pick a page type, then choose the URL, title and SEO settings. You'll
        add blocks on the next screen, and nothing goes live until you publish.
      </p>

      {pageTypes.length === 0 ? (
        <div className="flash-warning" role="status">
          No page types are published yet. Deploy the site, or check that its
          publish step ran against this database.
        </div>
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
            help="The path the page is served at, e.g. /about."
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
          <button type="submit" className="cms-save">
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
    title={`${page.title} - Billet CMS`}
    name="cms"
    description="A page that can't be edited."
    canonicalPath={`/cms/pages/${page.id}`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>{page.url}</span>
    </p>
    <h1>{page.title}</h1>
    <div className="flash-warning" role="alert">
      The page type <code>{page.pageType}</code> is no longer published. This
      page's content is kept but cannot be edited until it is declared again.
    </div>
  </Layout>
);
