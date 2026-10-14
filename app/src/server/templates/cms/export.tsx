import { Layout } from "../../components/layouts";
import type { ExportTokenRecord } from "../../services/export";
import type { User } from "../../services/users";

export interface ExportPageProps {
  user: User;
  navCsrfToken?: string;
  /** The CSRF token bound to the create form's POST. */
  createCsrfToken: string;
  /** One token per revoke form, keyed by token id. */
  revokeCsrfTokens: Record<string, string>;
  tokens: ExportTokenRecord[];
  /** The raw token, present only on the response that just created it. */
  newToken?: string | null;
  /** A one-line outcome, e.g. after a revoke. */
  notice?: string | null;
  /** Shown beside the create form when the label is missing. */
  error?: string | null;
}

const formatWhen = (date: Date): string =>
  date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

/**
 * The export tokens screen: the list, the create form, and — right after a
 * create — the one-time raw token.
 *
 * The raw token is rendered into this response and nowhere else: only its hash
 * is stored, so a reload loses it and a new token has to be created. That is
 * the point, not an oversight, and the copy says as much.
 */
export const ExportPage = ({
  user,
  navCsrfToken,
  createCsrfToken,
  revokeCsrfTokens,
  tokens,
  newToken,
  notice,
  error,
}: ExportPageProps) => (
  <Layout
    title="Export - Billet CMS"
    name="cms"
    description="Create tokens for pulling content into another environment."
    canonicalPath="/cms/export"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <p className="cms-breadcrumb">
      <a href="/cms">Content</a> / <span>Export</span>
    </p>
    <h1>Export</h1>
    <p className="cms-intro">
      An export token lets a local or preview environment pull this CMS's
      published content with <code>bun run cms:pull</code>. It is read-only,
      one-way, and can be revoked at any time. Images keep pointing at this
      CMS's bucket.
    </p>

    {notice && (
      <div className="flash-success" role="status">
        {notice}
      </div>
    )}

    {newToken && (
      <div className="flash-warning" role="status">
        <p>
          <strong>Copy this token now.</strong> It is shown once and only its
          hash is stored, so it can't be shown again.
        </p>
        <p>
          <code data-export-token>{newToken}</code>
        </p>
      </div>
    )}

    <section className="cms-page" aria-labelledby="export-tokens-heading">
      <h2 id="export-tokens-heading">Tokens</h2>
      {tokens.length === 0 ? (
        <div className="cms-empty-card" role="status">
          No export tokens yet.
        </div>
      ) : (
        <ul className="cms-slot-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <span className="cms-slot-meta">
                {token.label}
                {token.revokedAt ? (
                  <span className="cms-removed">
                    {" "}
                    Revoked {formatWhen(token.revokedAt)} UTC
                  </span>
                ) : token.lastUsedAt ? (
                  <span> Last used {formatWhen(token.lastUsedAt)} UTC</span>
                ) : (
                  <span> Never used</span>
                )}
              </span>
              {!token.revokedAt && (
                <form
                  method="POST"
                  action={`/cms/export/${token.id}/revoke`}
                  className="cms-inline-form"
                >
                  <input
                    type="hidden"
                    name="_csrf"
                    value={revokeCsrfTokens[token.id] ?? ""}
                  />
                  <button type="submit" className="btn-ghost">
                    Revoke
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>

    <section className="cms-page" aria-labelledby="export-create-heading">
      <h2 id="export-create-heading">New token</h2>
      {error && (
        <div className="flash-error" role="alert">
          {error}
        </div>
      )}
      <form method="POST" action="/cms/export">
        <input type="hidden" name="_csrf" value={createCsrfToken} />
        <div className="form-field">
          <label htmlFor="export-label">Name</label>
          <input
            id="export-label"
            name="label"
            type="text"
            required
            maxLength={100}
            placeholder="e.g. Alex's laptop"
          />
          <p className="form-field-help">
            Only so you can tell tokens apart in this list.
          </p>
        </div>
        <button type="submit" className="cms-save">
          Create token
        </button>
      </form>
    </section>
  </Layout>
);
