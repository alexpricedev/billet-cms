import { Flash } from "../../components/flash";
import { Layout } from "../../components/layouts";
import { PageHeader } from "../../components/page-header";
import type { ExportTokenRecord } from "../../services/export";
import { SITE_NAME } from "../../services/seo";
import type { User } from "../../services/users";
import { formatWhen } from "../../utils/format";

export interface ExportPageProps {
  user: User;
  navCsrfToken?: string;
  /** The CSRF token bound to the create form's POST. */
  createCsrfToken: string;
  /** The create form's one-use code; a second post of this form writes nothing. */
  nonce: string;
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

/**
 * The export tokens screen: the list, the create form, and — right after a
 * create — the one-time raw token.
 *
 * The raw token is rendered into this response and nowhere else: only its hash
 * is stored, so a reload loses it and a new token has to be created. That is
 * the point, not an oversight, and the copy says as much. The create form's
 * hidden nonce is spent by the create, so the reload re-posts a spent form and
 * is answered with a note rather than a second token.
 */
export const ExportPage = ({
  user,
  navCsrfToken,
  createCsrfToken,
  nonce,
  revokeCsrfTokens,
  tokens,
  newToken,
  notice,
  error,
}: ExportPageProps) => (
  <Layout
    title={`Export - ${SITE_NAME}`}
    name="cms"
    description="Create tokens for pulling content into another environment."
    canonicalPath="/cms/export"
    user={user}
    csrfToken={navCsrfToken}
    noindex
  >
    <PageHeader
      breadcrumb={
        <>
          <a href="/cms">Content</a> / <span>Export</span>
        </>
      }
      title="Export"
      description={
        <>
          An export token lets a local or preview environment pull this CMS's
          published content with <code>bun run cms:pull</code>. It is read-only,
          one-way, and can be revoked at any time. Images keep pointing at this
          CMS's bucket.
        </>
      }
    />

    {notice && <Flash tone="success" title={notice} dismissible />}

    {newToken && (
      <Flash
        tone="warning"
        title="Copy this token now."
        detail="It is shown once and only its hash is stored, so it can't be shown again."
        dismissible
      >
        <p className="cms-token-row" data-token-row>
          <code data-export-token>{newToken}</code>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-copy-token
            hidden
          >
            Copy
          </button>
        </p>
      </Flash>
    )}

    <section className="cms-page" aria-labelledby="export-tokens-heading">
      <h2 id="export-tokens-heading">Tokens</h2>
      {tokens.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="empty-state-title">No export tokens yet</span>
          <span>
            Create one below to pull content into another environment.
          </span>
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
                  data-confirm="Anything using this token stops working immediately."
                  data-confirm-title={`Revoke '${token.label}'?`}
                  data-confirm-label="Revoke"
                >
                  <input
                    type="hidden"
                    name="_csrf"
                    value={revokeCsrfTokens[token.id] ?? ""}
                  />
                  <button
                    type="submit"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Revoke ${token.label}`}
                  >
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
      {error && <Flash tone="error" title={error} dismissible />}
      <form
        method="POST"
        action="/cms/export"
        className="panel cms-export-create"
      >
        <input type="hidden" name="_csrf" value={createCsrfToken} />
        <input type="hidden" name="nonce" value={nonce} />
        <div className="form-field">
          <label htmlFor="export-label">Name</label>
          <input
            id="export-label"
            name="label"
            type="text"
            required
            maxLength={100}
            placeholder="e.g. Alex's laptop"
            aria-describedby="export-label-help"
          />
          <p className="cms-field-help" id="export-label-help">
            Only so you can tell tokens apart in this list.
          </p>
        </div>
        <button type="submit" className="cms-save btn btn-primary">
          Create token
        </button>
      </form>
    </section>
  </Layout>
);
