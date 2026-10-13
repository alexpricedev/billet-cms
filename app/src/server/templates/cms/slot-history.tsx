import { Layout } from "../../components/layouts";
import type { SlotRecord, SlotRevisionSummary } from "../../services/content";
import type { User } from "../../services/users";

export interface SlotHistoryProps {
  user: User;
  slot: SlotRecord;
  revisions: SlotRevisionSummary[];
  /** The CSRF token bound to the restore POST. */
  restoreCsrfToken: string;
  navCsrfToken?: string;
  /** Why a restore didn't land, when one was attempted. */
  notice?: string | null;
}

const formatWhen = (date: Date): string =>
  date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

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
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> /{" "}
      <a href={`/cms/slots/${slot.id}`}>{slot.label ?? slot.name}</a> /{" "}
      <span>History</span>
    </p>
    <h1>History</h1>
    <p className="cms-slot-meta">
      Slot <code>{slot.name}</code>
    </p>

    {notice && (
      <div className="flash-warning" role="status">
        {notice}
      </div>
    )}

    {revisions.length === 0 ? (
      <div className="cms-history-empty" role="status">
        This slot has no saved revisions yet.
      </div>
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
                <button type="submit" className="cms-restore-button">
                  Restore as draft
                </button>
              </form>
            )}
          </li>
        ))}
      </ol>
    )}
  </Layout>
);
