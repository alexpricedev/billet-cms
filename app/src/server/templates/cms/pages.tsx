import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type {
  PageRecord,
  PageTypeRecord,
  RedirectRecord,
} from "../../services/content";
import type { User } from "../../services/users";

export interface PagesListProps {
  user: User;
  navCsrfToken?: string;
  pages: PageRecord[];
  pageTypes: PageTypeRecord[];
  redirects: RedirectRecord[];
  /** A one-line outcome shown above the list, e.g. after a delete. */
  notice?: string | null;
}

/** The CMS's pages: what's published, what's a draft, and where old URLs go. */
export const PagesList = ({
  user,
  navCsrfToken,
  pages,
  pageTypes,
  redirects,
  notice,
}: PagesListProps) => (
  <Layout
    title="Pages - Billet CMS"
    name="cms"
    description="Manage the site's pages."
    canonicalPath="/cms/pages"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <span>Pages</span>
        </>
      }
      title="Pages"
      description="A page is served at its URL after the site's own routes, published from the CMS. Renaming one leaves a 301 from its old URL."
      actions={
        <a className="btn btn-primary" href="/cms/pages/new">
          New page
        </a>
      }
    />

    {notice && (
      <div className="flash-success" role="status">
        {notice}
      </div>
    )}

    {pages.length === 0 ? (
      <div className="cms-empty-card" role="status">
        No pages yet. Create one to add content the site serves at its own URL.
      </div>
    ) : (
      <ul className="cms-page-list">
        {pages.map((page) => (
          <li key={page.id} className="cms-page-list-item">
            <a className="cms-page-link" href={`/cms/pages/${page.id}`}>
              {page.title}
            </a>
            <span className="cms-page-meta">
              <code>{page.url}</code>
              <span className="cms-page-type">{page.pageType}</span>
              {page.publishedRevisionId ? (
                <span className="cms-published-badge">Published</span>
              ) : (
                <span className="cms-draft-badge">Draft</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    )}

    <section className="cms-page">
      <h2>Redirects</h2>
      {redirects.length === 0 ? (
        <p className="cms-intro">
          No redirects. Renaming a page's URL adds a 301 from the old URL here.
        </p>
      ) : (
        <ul className="cms-redirect-list">
          {redirects.map((redirect) => {
            const target = pages.find((page) => page.id === redirect.toPageId);
            return (
              <li key={redirect.id}>
                <code>{redirect.fromPath}</code> →{" "}
                <a href={`/cms/pages/${redirect.toPageId}`}>
                  {target?.title ?? redirect.toPageId}
                </a>
                {target && (
                  <code className="cms-redirect-target">{target.url}</code>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>

    {pageTypes.length > 0 && (
      <section className="cms-page">
        <h2>Page types</h2>
        <ul className="cms-page-type-list">
          {pageTypes.map((pageType) => (
            <li key={pageType.id}>
              {pageType.label ?? pageType.name}
              {pageType.label &&
                pageType.label.toLowerCase() !==
                  pageType.name.toLowerCase() && <code>{pageType.name}</code>}
              {pageType.removedAt && (
                <span className="cms-removed"> (no longer declared)</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    )}
  </Layout>
);
