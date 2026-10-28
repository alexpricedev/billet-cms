import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { PageRecord, PageUsage } from "../../services/content";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";

export interface PageDeleteConfirmProps {
  user: User;
  /** The CSRF token bound to the delete POST. */
  csrfToken: string;
  /** The CSRF token bound to the nav's sign-out POST. */
  navCsrfToken?: string;
  page: PageRecord;
  /** The redirects and pages the delete would leave dangling. */
  usage: PageUsage;
}

/**
 * The confirm step before a page is deleted.
 *
 * Deleting a page is one click from the editor, so this stands between the two:
 * it names the page, how many redirects point at it and which pages link to it,
 * so the editor sees what stops resolving. It is a warning, not a gate — the
 * button deletes whatever the counts say.
 */
export const PageDeleteConfirm = ({
  user,
  csrfToken,
  navCsrfToken,
  page,
  usage,
}: PageDeleteConfirmProps) => (
  <Layout
    title={`Delete ${page.title} - ${SITE_NAME}`}
    name="cms"
    description="Confirm deleting a page."
    canonicalPath={`/cms/pages/${page.id}/delete`}
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <a href="/cms/pages">Pages</a> /{" "}
          <a href={`/cms/pages/${page.id}`}>{page.title}</a> /{" "}
          <span>Delete</span>
        </>
      }
      title="Delete page"
      description={
        <>
          Deleting <strong>{page.title}</strong> removes the page served at{" "}
          <code>{page.url}</code>. Its revisions stay in history, but nothing
          answers at that URL until another page or redirect claims it.
        </>
      }
    />

    <section className="cms-page" aria-label="What points here">
      <h2>What points here</h2>
      <ul className="cms-delete-usage">
        <li>
          <strong>{usage.redirectCount}</strong>{" "}
          {usage.redirectCount === 1 ? "redirect points" : "redirects point"} to
          this page.
        </li>
        <li>
          <strong>{usage.linkingPages.length}</strong>{" "}
          {usage.linkingPages.length === 1 ? "page links" : "pages link"} to it.
        </li>
      </ul>

      {usage.linkingPages.length > 0 && (
        <ul className="cms-page-list">
          {usage.linkingPages.map((linking) => (
            <li key={linking.id} className="cms-page-list-item">
              <a className="cms-page-link" href={`/cms/pages/${linking.id}`}>
                {linking.title}
              </a>
              <span className="cms-page-meta">
                <code>{linking.url}</code>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="cms-intro">
        None of this stops the delete: those redirects and links simply stop
        resolving.
      </p>
    </section>

    <section className="cms-danger" aria-label="Confirm delete">
      <form method="POST" action={`/cms/pages/${page.id}/delete`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <button type="submit" className="cms-delete-button">
          Delete page
        </button>
      </form>
      <a className="cms-delete-cancel" href={`/cms/pages/${page.id}`}>
        Cancel
      </a>
    </section>
  </Layout>
);
