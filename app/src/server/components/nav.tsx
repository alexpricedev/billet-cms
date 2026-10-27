import type { User } from "../services/users";
import { CsrfField } from "./csrf-field";
import { Logo } from "./logo";

// The CMS's own surface, shown only to someone signed in.
interface NavItem {
  href: string;
  label: string;
  /** The path prefix that marks this item current. */
  match: string;
  icon: "overview" | "pages" | "media" | "export";
}

const items: readonly NavItem[] = [
  { href: "/cms", label: "Content", match: "/cms", icon: "overview" },
  { href: "/cms/pages", label: "Pages", match: "/cms/pages", icon: "pages" },
  { href: "/cms/media", label: "Media", match: "/cms/media", icon: "media" },
  {
    href: "/cms/export",
    label: "Export",
    match: "/cms/export",
    icon: "export",
  },
];

// Paths that should light up an item. The dashboard is exact (`/cms`,
// `/cms?…`) so a child route never highlights both it and its own item.
const isCurrent = (item: NavItem, path: string | undefined): boolean => {
  if (path === undefined) return false;
  const pathname = path.split(/[?#]/)[0];
  if (item.match === "/cms") {
    return pathname === "/cms" || pathname === "/cms/";
  }
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
};

const Icon = ({ name }: { name: NavItem["icon"] }) => {
  const paths: Record<NavItem["icon"], string> = {
    overview: "M3 9.5 10 3l7 6.5V17H3V9.5Z",
    pages: "M5 3h7l3 3v11H5V3Zm7 0v3h3M8 9h4M8 13h4",
    media: "M3 4h14v12H3V4Zm0 9 4-4 3 3 2-2 5 5",
    export: "M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 15v2h12v-2",
  };
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class="nav-icon"
    >
      <path d={paths[name]} />
    </svg>
  );
};

interface NavProps {
  page: string;
  user?: User | null;
  csrfToken?: string;
  /** The page's canonical path, so the current sidebar item stays lit. */
  canonicalPath?: string;
}

export const Nav = ({ page, user, csrfToken, canonicalPath }: NavProps) => {
  // A signed-out visitor, and every error page, gets the plain top bar: no
  // destinations to group and no account to manage.
  const variant = user ? "app" : "plain";

  return (
    <nav
      data-component="nav"
      data-variant={variant}
      aria-label="Main navigation"
    >
      <a href="/" className="logo nav-brand">
        <Logo />
        <span>Billet CMS</span>
      </a>
      {/* Rendered hidden and unhidden by src/client/components/nav-menu.ts.
          Without that script — an error page ships none, and JavaScript may be
          off — the button would toggle nothing, so the panel is only revealed
          by CSS where it is always safe to show (the wide layout). */}
      <button
        type="button"
        className="nav-toggle"
        aria-expanded="false"
        aria-controls="nav-menu"
        hidden
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
        <span className="sr-only">Menu</span>
      </button>
      {/* Wrapper only so the toggle has a single thing to reveal. */}
      <div id="nav-menu" className="nav-panel">
        {user && (
          <>
            <p className="nav-group-label" id="nav-workspace-label">
              Workspace
            </p>
            <ul className="nav-list" aria-labelledby="nav-workspace-label">
              {items.map((item) => {
                const current =
                  isCurrent(item, canonicalPath) ||
                  (canonicalPath === undefined &&
                    item.match === "/cms" &&
                    page === "cms");
                return (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      className="nav-link"
                      aria-current={current ? "page" : undefined}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="nav-auth">
          {user ? (
            <>
              <a
                href="/account"
                className="nav-link nav-account"
                aria-current={page === "account" ? "page" : undefined}
              >
                <span className="nav-avatar" aria-hidden="true">
                  {user.email.slice(0, 1).toUpperCase()}
                </span>
                <span className="nav-account-text">
                  <span className="nav-account-label">Account</span>
                  <span className="nav-account-email">{user.email}</span>
                </span>
              </a>
              <form method="post" action="/auth/logout">
                <CsrfField token={csrfToken ?? null} />
                <button type="submit" className="btn btn-ghost btn-sm">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <a href="/sign-in" className="btn btn-secondary btn-sm">
              Sign in
            </a>
          )}
        </div>
      </div>
    </nav>
  );
};
