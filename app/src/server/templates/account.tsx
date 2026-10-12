import { Layout } from "../components/layouts";
import type { User } from "../services/users";

export interface AccountProps {
  user: User;
  // Token for the nav's sign-out form, bound to its POST /auth/logout.
  csrfToken?: string;
}

export const Account = ({ user, csrfToken }: AccountProps) => (
  <Layout
    title="Account - Billet CMS"
    name="account"
    description="Your Billet CMS account."
    canonicalPath="/account"
    user={user}
    csrfToken={csrfToken}
    noindex
  >
    <h1>Account</h1>

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
        <dd>Magic link</dd>
      </dl>
    </section>
  </Layout>
);
