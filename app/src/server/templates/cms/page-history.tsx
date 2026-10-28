import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { PageRecord, PageRevisionSummary } from "../../services/content";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { formatDay, formatDayShort, formatWhen } from "../../utils/format";

export interface PageHistoryProps {
  user: User;
  page: PageRecord;
  revisions: PageRevisionSummary[];
  /** The CSRF token bound to the restore POST. */
  restoreCsrfToken: string;
  navCsrfToken?: string;
  notice?: string | null;
}

/**
 * A page's revision history. Restoring copies an older revision into a new
 * draft; nothing is rewritten or deleted.
 */
export const PageHistory = ({
  user,
  page,
  revisions,
  restoreCsrfToken,
  navCsrfToken,
  notice,
}: PageHistoryProps) => (
  <Layout
    title={`${page.title} history - ${SITE_NAME}`}
    name="cms"
    description="A page's revision history."
    canonicalPath={`/cms/pages/${page.id}/history`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
          <a href={`/cms/pages/${page.id}`}>{page.title}</a> /{" "}
          <span>History</span>
        </>
      }
      title="History"
      after={
        <p className="cms-slot-meta">
          Page <code>{page.url}</code>
        </p>
      }
    />

    {notice && (
      <div className="flash-warning" role="status">
        {notice}
      </div>
    )}

    {revisions.length === 0 ? (
      <p className="cms-history-empty">This page has no saved revisions yet.</p>
    ) : (
      <ol className="cms-history">
        {revisions.map((revision) => (
          <li className="cms-history-item" key={revision.id}>
            <div className="cms-history-meta">
              <span className="cms-history-when">
                {formatWhen(revision.createdAt)} UTC
              </span>
              <span className="cms-history-author">
                {revision.authorEmail ?? "Unknown"}
              </span>
              {revision.isPublished && (
                <span className="cms-history-badge cms-history-published">
                  Published
                </span>
              )}
              {revision.restoredFromAt && (
                <span className="cms-history-badge cms-history-restored">
                  Restored from {formatDay(revision.restoredFromAt)}
                </span>
              )}
              {revision.isLatest && (
                <span className="cms-history-badge cms-history-draft">
                  Current draft
                </span>
              )}
            </div>
            {!revision.isLatest && (
              <form
                method="POST"
                action={`/cms/pages/${page.id}/restore`}
                className="cms-history-restore"
              >
                <input type="hidden" name="_csrf" value={restoreCsrfToken} />
                <input type="hidden" name="revision" value={revision.id} />
                <button
                  type="submit"
                  className="cms-restore-button"
                  aria-label={`Restore the ${formatDayShort(revision.createdAt)} version, saved ${formatWhen(revision.createdAt)} UTC by ${revision.authorEmail ?? "an unknown author"} as draft`}
                >
                  Restore the {formatDayShort(revision.createdAt)} version
                </button>
              </form>
            )}
          </li>
        ))}
      </ol>
    )}
  </Layout>
);
