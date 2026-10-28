import { Layout } from "../components/layouts";
import { PageHeader } from "../components/page-header";
import { SITE_NAME } from "../services/seo";
import type { User } from "../services/users";

export interface AccountProps {
  user: User;
  // Token for the nav's sign-out form, bound to its POST /auth/logout.
  csrfToken?: string;
}

export const Account = ({ user, csrfToken }: AccountProps) => (
  <Layout
    title={`Account - ${SITE_NAME}`}
    name="account"
    description={`Your ${SITE_NAME} account.`}
    canonicalPath="/account"
    user={user}
    csrfToken={csrfToken}
    noindex
  >
    <PageHeader
      title="Account"
      description="You sign in through the site. The CMS never stores a password of its own."
    />

    <section className="account-section card">
      <h2>Email address</h2>
      <p className="account-email">{user.email}</p>
    </section>

    <section className="account-section card">
      <h2>Details</h2>
      <dl className="account-details">
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Sign-in method</dt>
        <dd>Through the site</dd>
      </dl>
    </section>
  </Layout>
);
