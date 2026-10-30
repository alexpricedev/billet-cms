import type { ComponentChildren } from "preact";

export type FlashTone = "success" | "info" | "warning" | "error";

/** A link under the banner's text, e.g. "Preview draft ↗". */
export interface FlashAction {
  href: string;
  label: string;
  /** Open in a new tab — for links that leave the CMS. */
  newTab?: boolean;
}

/**
 * One line in the banner's list: an invalid field, linked to its control, or a
 * message with nothing to link to (a page-limit issue, an unreadable body).
 */
export interface FlashField {
  /** The control's id; when absent the line renders as plain text. */
  id?: string;
  label: string;
}

interface FlashProps {
  tone: FlashTone;
  title?: ComponentChildren;
  detail?: ComponentChildren;
  actions?: readonly FlashAction[];
  fields?: readonly FlashField[];
  /**
   * Extra body markup between the detail line and the actions, for a banner
   * whose body is not a sentence (the removed-fields list, the one-time export
   * token). Prefer `detail` for plain text.
   */
  children?: ComponentChildren;
  /**
   * Render the × — for a banner reporting the result of an action the editor
   * just took. A banner describing the page's own state stays put: closing it
   * would leave the page emptier and a reload would bring it back.
   */
  dismissible?: boolean;
}

// One 20px line icon per tone. The tone is carried by the shape as well as the
// colour, so the four states stay distinguishable without relying on colour.
const iconFor = (tone: FlashTone) => {
  switch (tone) {
    case "success":
      return (
        <>
          <circle cx="10" cy="10" r="8" />
          <path d="m6.3 10.2 2.4 2.4 4.9-5.4" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="10" cy="10" r="8" />
          <path d="M10 9.2v5" />
          <circle cx="10" cy="6.1" r="0.9" fill="currentColor" stroke="none" />
        </>
      );
    case "warning":
      return (
        <>
          <path d="M10 3.1 17.5 16.4H2.5L10 3.1Z" />
          <path d="M10 8.1v3.9" />
          <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
        </>
      );
    case "error":
      return (
        <>
          <circle cx="10" cy="10" r="8" />
          <path d="M10 5.9v5.3" />
          <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
        </>
      );
  }
};

const Icon = ({ tone }: { tone: FlashTone }) => (
  <svg
    className="flash-icon"
    viewBox="0 0 20 20"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {iconFor(tone)}
  </svg>
);

// Informational and advisory messages are announced politely; only an error
// interrupts, because only an error stops the editor's work succeeding.
const roleFor = (tone: FlashTone): "status" | "alert" =>
  tone === "error" ? "alert" : "status";

/**
 * A banner at the top of a page or an editor: one message, optionally with a
 * detail line, action links and a list of field errors.
 *
 * The × is opt-in (`dismissible`) and ships hidden.
 * `src/client/components/flash-dismiss.ts` reveals it, so a page without
 * JavaScript still shows the banner and simply cannot close it. Errors are
 * announced assertively; the other tones politely.
 */
export const Flash = ({
  tone,
  title,
  detail,
  actions,
  fields,
  children,
  dismissible = false,
}: FlashProps) => {
  return (
    <div className="flash" data-tone={tone} role={roleFor(tone)}>
      <Icon tone={tone} />
      <div className="flash-body">
        {title !== undefined && <p className="flash-title">{title}</p>}
        {detail !== undefined && <p className="flash-detail">{detail}</p>}
        {children}
        {actions && actions.length > 0 && (
          <p className="flash-actions">
            {actions.map((action) => (
              <a
                key={`${action.href}:${action.label}`}
                href={action.href}
                target={action.newTab ? "_blank" : undefined}
                rel={action.newTab ? "noreferrer" : undefined}
              >
                {action.label}
              </a>
            ))}
          </p>
        )}
        {fields && fields.length > 0 && (
          <ul className="flash-fields">
            {fields.map((field) => (
              <li key={`${field.id ?? ""}:${field.label}`}>
                {field.id ? (
                  <a href={`#${field.id}`}>{field.label}</a>
                ) : (
                  field.label
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {dismissible && (
        <button
          type="button"
          className="flash-dismiss"
          aria-label="Dismiss"
          data-flash-dismiss
          hidden
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
};
