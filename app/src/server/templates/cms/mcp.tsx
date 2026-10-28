import { Flash } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { McpGrantSummary } from "../../mcp/oauth/tokens";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";

export interface McpPageProps {
  user: User;
  navCsrfToken?: string;
  /** One token per revoke form, keyed by grant id. */
  revokeCsrfTokens: Record<string, string>;
  grants: McpGrantSummary[];
  /** The MCP endpoint a client is pointed at, e.g. https://cms.example.com/mcp. */
  serverUrl: string;
  notice?: string | null;
  error?: string | null;
}

const GrantMeta = ({ grant }: { grant: McpGrantSummary }) => (
  <span className="cms-slot-meta">
    <strong>{grant.clientName}</strong>
    <span> as {grant.identityEmail ?? "a removed account"}</span>
    {grant.revokedAt ? (
      <span className="cms-removed">
        {" "}
        — revoked {formatWhen(grant.revokedAt)} UTC
      </span>
    ) : (
      <>
        <span> — connected {formatWhen(grant.createdAt)} UTC</span>
        <span>
          {grant.lastUsedAt
            ? `, last used ${formatWhen(grant.lastUsedAt)} UTC`
            : ", never used"}
        </span>
      </>
    )}
  </span>
);

/**
 * The Connected apps screen.
 *
 * One grant is one consent: a client, the person it acts as, and the single
 * permission this CMS issues. Revoking is a POST with its own CSRF token bound
 * to the grant's path, so a link prefetch cannot disconnect anything.
 */
export const McpPage = ({
  user,
  navCsrfToken,
  revokeCsrfTokens,
  grants,
  serverUrl,
  notice,
  error,
}: McpPageProps) => {
  const active = grants.filter((grant) => !grant.revokedAt);
  const revoked = grants.filter((grant) => grant.revokedAt);

  return (
    <Layout
      title={`Connected apps - ${SITE_NAME}`}
      name="cms"
      description="Apps connected to this CMS through MCP."
      canonicalPath="/cms/mcp"
      user={user}
      csrfToken={navCsrfToken}
      noindex
    >
      <PageHeader
        breadcrumb={
          <>
            <a href="/cms">Content</a> / <span>Connected apps</span>
          </>
        }
        title="Connected apps"
        description={
          <>
            Apps connect through the MCP server at <code>{serverUrl}</code>.
            Each one acts as the person who approved it and can read and change
            all content, including publishing and deleting. Revoking disconnects
            it immediately.
          </>
        }
      />

      {notice && <Flash tone="success" title={notice} />}
      {error && <Flash tone="error" title={error} />}

      <section className="cms-page" aria-labelledby="connected-heading">
        <h2 id="connected-heading">Connected</h2>
        {active.length === 0 ? (
          <div className="empty-state" role="status">
            <span className="empty-state-title">No apps are connected yet</span>
            <span>
              Add <code>{serverUrl}</code> in Claude or ChatGPT and approve the
              consent screen.
            </span>
          </div>
        ) : (
          <ul className="cms-slot-list">
            {active.map((grant) => (
              <li key={grant.id}>
                <GrantMeta grant={grant} />
                <form
                  method="POST"
                  action={`/cms/mcp/${grant.id}/revoke`}
                  className="cms-inline-form"
                  data-confirm="The app loses access immediately. You can connect it again from the client."
                  data-confirm-title={`Disconnect ${grant.clientName}?`}
                  data-confirm-label="Disconnect"
                >
                  <input
                    type="hidden"
                    name="_csrf"
                    value={revokeCsrfTokens[grant.id] ?? ""}
                  />
                  <button
                    type="submit"
                    className="btn btn-ghost"
                    aria-label={`Disconnect ${grant.clientName}`}
                  >
                    Disconnect
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section className="cms-page" aria-labelledby="revoked-heading">
          <h2 id="revoked-heading">Disconnected</h2>
          <ul className="cms-slot-list">
            {revoked.map((grant) => (
              <li key={grant.id}>
                <GrantMeta grant={grant} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </Layout>
  );
};
