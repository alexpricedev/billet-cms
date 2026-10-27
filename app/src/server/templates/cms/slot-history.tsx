import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { SlotRecord, SlotRevisionSummary } from "../../services/content";
import type { User } from "../../services/users";
import { formatDay, formatDayShort, formatWhen } from "../../utils/format";

export interface SlotHistoryProps {
  user: User;
  slot: SlotRecord;
  revisions: SlotRevisionSummary[];
  /** Where "Show older" points, when older revisions remain; null on the last page. */
  olderHref?: string | null;
  /** The CSRF token bound to the restore POST. */
  restoreCsrfToken: string;
  navCsrfToken?: string;
  /** Why a restore didn't land, when one was attempted. */
  notice?: string | null;
}

/**
 * A slot's revision history.
 *
 * Every save is immutable, so this is the whole record: who saved what and
 * when, which one the site is rendering, and a Restore button that copies an
 * older revision into a new draft. Restoring never deletes or rewrites the row
 * it came from.
 */
export const SlotHistory = ({
  user,
  slot,
  revisions,
  olderHref,
  restoreCsrfToken,
  navCsrfToken,
  notice,
}: SlotHistoryProps) => (
  <Layout
    title={`${slot.label ?? slot.name} history - Billet CMS`}
    name="cms"
    description="A slot's revision history."
    canonicalPath={`/cms/slots/${slot.id}/history`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> /{" "}
          <a href={`/cms/slots/${slot.id}`}>{slot.label ?? slot.name}</a> /{" "}
          <span>History</span>
        </>
      }
      title="History"
      after={
        <p className="cms-slot-meta">
          Slot <code>{slot.name}</code>
        </p>
      }
    />

    {notice && (
      <div className="flash-warning" role="status">
        {notice}
      </div>
    )}

    {revisions.length === 0 ? (
      <p className="cms-history-empty">
        {olderHref
          ? "No revisions on this page."
          : "This slot has no saved revisions yet."}
      </p>
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
                action={`/cms/slots/${slot.id}/restore`}
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

    {olderHref && (
      <p className="cms-history-older">
        <a href={olderHref}>Show older</a>
      </p>
    )}
  </Layout>
);
