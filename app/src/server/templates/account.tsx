import { CsrfField } from "../components/csrf-field";
import { Flash } from "../components/flash";
import { Layout } from "../components/layouts";
import { PageHeader } from "../components/page-header";
import type { Theme } from "../services/preferences";
import { SITE_NAME } from "../services/seo";
import type { User } from "../services/users";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export interface AccountProps {
  user: User;
  // Token for the nav's sign-out form, bound to its POST /auth/logout.
  csrfToken?: string;
  // Token for the Theme card's form, bound to its POST /account/theme.
  themeCsrfToken?: string;
  // The outcome of a theme save, read from the redirect's query flag.
  notice?: { type: "success" | "warning"; message: string } | null;
}

export const Account = ({
  user,
  csrfToken,
  themeCsrfToken,
  notice,
}: AccountProps) => {
  // Absent means System: a User built from an identity alone has no saved row.
  const currentTheme: Theme = user.theme ?? "system";

  return (
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

      {notice && <Flash tone={notice.type} title={notice.message} />}

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

      <section className="account-section card">
        <h2>Theme</h2>
        {/* A plain form: with JavaScript off the radios post and the page
          redirects back with its notice, like every other mutation here. */}
        <form
          method="POST"
          action="/account/theme"
          className="account-theme-form"
        >
          <CsrfField token={themeCsrfToken} />
          <fieldset className="field choice-group">
            <legend className="sr-only">Theme</legend>
            {THEME_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={currentTheme === option.value}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <button type="submit" className="btn btn-primary">
            Save theme
          </button>
        </form>
      </section>
    </Layout>
  );
};
