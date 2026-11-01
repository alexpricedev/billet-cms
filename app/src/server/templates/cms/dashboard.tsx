import { Flash } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { SlotPageGroup, SlotState } from "../../services/content";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { humanise } from "../../utils/humanise";

export interface DashboardProps {
  user: User;
  navCsrfToken?: string;
  groups: SlotPageGroup[];
  slotStates?: Map<string, SlotState>;
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

/** The CMS home: the pages a site declares and their slots. */
export const Dashboard = ({
  user,
  navCsrfToken,
  groups,
  slotStates,
}: DashboardProps) => (
  <Layout
    title={`Content - ${SITE_NAME}`}
    name="cms"
    description="Manage the content of the site's blocks."
    canonicalPath="/cms"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      title="Content"
      description="These are the parts of the site you can edit. Your changes stay drafts until you publish them."
    />

    {groups.length === 0 ? (
      <Flash
        tone="warning"
        title="No slots are published yet."
        detail="Deploy the site, or check that its publish step ran against this database."
      />
    ) : (
      groups.map((group) => (
        <section className="cms-page" key={group.page}>
          <h2>{humanise(group.page)}</h2>
          <ul className="cms-slot-list">
            {group.slots.map((slot) => (
              <li key={slot.id}>
                <a className="cms-slot-link" href={`/cms/slots/${slot.id}`}>
                  {slot.label ?? humanise(slot.name)}
                </a>
                {(slotStates?.get(slot.id) || slot.removedAt) && (
                  <span className="cms-slot-meta">
                    {slotStates?.get(slot.id) && (
                      <SlotStateBadge
                        state={slotStates.get(slot.id) as SlotState}
                      />
                    )}
                    {slot.removedAt && (
                      <span className="cms-removed">No longer declared</span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))
    )}
  </Layout>
);
