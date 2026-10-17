import type { ComponentChildren } from "preact";
import { BaseLayout } from "./layouts";
import { Logo } from "./logo";

interface AuthPageProps {
  title: string;
  description: string;
  canonicalPath: string;
  heading: string;
  subtitle: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

/**
 * Shared chrome for the CMS's chrome-less pages. The only one today is the
 * `/handoff` confirm step, the half of site-routed sign-in where the browser
 * comes back from the site with a single-use token to spend.
 *
 * Uses BaseLayout rather than Layout — no nav, no client bundle, and always
 * noindex. Nothing here should be crawled or invite a signed-out visitor to
 * wander off mid-flow.
 */
export const AuthPage = ({
  title,
  description,
  canonicalPath,
  heading,
  subtitle,
  children,
  footer,
}: AuthPageProps) => (
  <BaseLayout
    title={title}
    description={description}
    canonicalPath={canonicalPath}
    noindex
  >
    <main className="login-page">
      <div className="login-wrapper">
        <div className="login-header">
          <a href="/">
            <Logo />
          </a>
        </div>

        <div className="login-card">
          <h1 className="login-title">{heading}</h1>
          <p className="login-subtitle">{subtitle}</p>

          {children}
        </div>

        <div className="login-footer">
          {footer ?? <a href="/cms">Back to Billet CMS</a>}
        </div>
      </div>
    </main>
  </BaseLayout>
);
