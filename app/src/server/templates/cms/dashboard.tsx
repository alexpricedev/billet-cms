import { Layout } from "../../components/layouts";
import type {
  PageTypeRecord,
  SlotPageGroup,
  SlotState,
} from "../../services/content";
import type { User } from "../../services/users";

export interface DashboardProps {
  user: User;
  navCsrfToken?: string;
  groups: SlotPageGroup[];
  slotStates?: Map<string, SlotState>;
  pageTypes: PageTypeRecord[];
}

const formatDate = (date: Date) =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const SlotStateBadge = ({ state }: { state: SlotState }) =>
  state.kind === "draft" ? (
    <span className="cms-slot-state cms-slot-state-draft">
      Draft since {formatDate(state.since)}
    </span>
  ) : state.kind === "never" ? (
    <span className="cms-slot-state cms-slot-state-never">Never published</span>
  ) : (
    <span className="cms-slot-state cms-slot-state-live">Live</span>
  );

/** The CMS home: the pages a site declares, their slots, and its page types. */
export const Dashboard = ({
  user,
  navCsrfToken,
  groups,
  slotStates,
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
      These are the parts of the site you can edit. Your changes stay drafts
      until you publish them.
    </p>

    <p className="cms-new-page">
      <a className="cms-new-page-link" href="/cms/pages">
        Pages
      </a>{" "}
      <a className="cms-new-page-link" href="/cms/media">
        Media
      </a>{" "}
      <a className="cms-new-page-link" href="/cms/export">
        Export
      </a>
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
                <a className="cms-slot-link" href={`/cms/slots/${slot.id}`}>
                  {slot.label ?? slot.name}
                </a>
                <span className="cms-slot-meta">
                  {/* Only when it adds something: an unlabelled slot already
                      shows its name as the link, so repeating it as <code>
                      says it twice. */}
                  {slot.label ? <code>{slot.name}</code> : null}
                  <span className="cms-slot-block">{slot.blockName}</span>
                  {slotStates?.get(slot.id) && (
                    <SlotStateBadge
                      state={slotStates.get(slot.id) as SlotState}
                    />
                  )}
                  {slot.removedAt && (
                    <span className="cms-removed">No longer declared</span>
                  )}
                </span>
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
