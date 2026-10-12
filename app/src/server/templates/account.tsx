import { CsrfField } from "../components/csrf-field";
import { Layout } from "../components/layouts";
import type { User } from "../services/users";

export interface AccountProps {
  user: User;
  // Token for the sign-out form, bound to this page's POST.
  csrfToken?: string;
}

const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

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
        <dt>Member since</dt>
        <dd>{formatDate(user.created_at)}</dd>
        <dt>Sign-in method</dt>
        <dd>Magic link</dd>
      </dl>
    </section>

    <section className="account-section card">
      <h2>Sign out</h2>
      <form method="POST" action="/auth/logout">
        <CsrfField token={csrfToken ?? null} />
        <button type="submit" className="btn-ghost">
          Sign out
        </button>
      </form>
    </section>
  </Layout>
);
