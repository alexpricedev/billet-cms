import { Layout } from "../../components/layouts";
import type { PageTypeRecord, SlotPageGroup } from "../../services/content";
import type { User } from "../../services/users";

export interface DashboardProps {
  user: User;
  navCsrfToken?: string;
  groups: SlotPageGroup[];
  pageTypes: PageTypeRecord[];
}

/** The CMS home: the pages a site declares, their slots, and its page types. */
export const Dashboard = ({
  user,
  navCsrfToken,
  groups,
  pageTypes,
}: DashboardProps) => (
  <Layout
    title="Content - Billet CMS"
    name="cms"
    description="Manage the content of the site's blocks."
    canonicalPath="/cms"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <h1>Content</h1>
    <p className="cms-intro">
      Slots are declared in the site's templates and published on deploy. Edit
      one here; changes are saved as drafts.
    </p>

    {groups.length === 0 ? (
      <div className="flash-warning" role="status">
        No slots are published yet. Deploy the site, or check that its publish
        step ran against this database.
      </div>
    ) : (
      groups.map((group) => (
        <section className="cms-page" key={group.page}>
          <h2>{group.page}</h2>
          <ul className="cms-slot-list">
            {group.slots.map((slot) => (
              <li key={slot.id}>
                <a href={`/cms/slots/${slot.id}`}>{slot.label ?? slot.name}</a>{" "}
                <code>{slot.name}</code>{" "}
                <span className="cms-slot-block">{slot.blockName}</span>
                {slot.removedAt && (
                  <span className="cms-removed"> (no longer declared)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))
    )}

    {pageTypes.length > 0 && (
      <section className="cms-page">
        <h2>Page types</h2>
        <ul className="cms-page-type-list">
          {pageTypes.map((pageType) => (
            <li key={pageType.id}>
              {pageType.label ?? pageType.name} <code>{pageType.name}</code>
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
