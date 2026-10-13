/**
 * Render a stored rich text document to HTML, for the site (Q1).
 *
 * The CMS ships an editable walker of the same document
 * (`app/src/server/components/cms/rich-text.tsx`); this is the read-side one,
 * and it has a different job. The editor can trust its input because the form
 * was built from the validated revision. A public page cannot: it renders
 * whatever is in `cms_revisions`, so every string here is escaped and the node
 * set is closed. An unrecognised node or mark renders nothing rather than
 * falling through to raw markup, which is what keeps a hand-edited row — or a
 * future editor whose toolbar grew a node — from becoming stored XSS.
 *
 * Links get one extra check. The stored schema already restricts `href` to the
 * shared allowlist (`http(s)`, `mailto`, `tel`, `/`, `#`), so a `javascript:`
 * URL should never reach here; the renderer verifies it again and drops the
 * anchor rather than trusting that. Escaping an attribute is not enough on its
 * own for a scheme the browser will execute.
 */
import type { RichTextDocument } from "../fields/rich-text";
import { URL_PATTERN } from "../fields/url";

/** Escape a string for HTML text and for a quoted attribute value. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Read a JSON object defensively.
 *
 * Everything below walks a row the renderer did not validate, so a hand-edited
 * string where an object belongs has to read as "nothing here" rather than
 * throwing a TypeError out of a page render. Arrays are excluded: none of the
 * shapes this walker handles is an array, and a bare array has no `.type`.
 */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const renderMarks = (marks: unknown, children: string): string => {
  if (!Array.isArray(marks) || marks.length === 0) return children;

  // Outermost mark first, so the nesting reads the same way the JSON lists it
  // and matches the CMS editor's own walker.
  return marks.reduceRight<string>((wrapped, raw) => {
    const mark = asRecord(raw);
    if (!mark) return wrapped;

    if (mark.type === "bold") return `<strong>${wrapped}</strong>`;
    if (mark.type === "italic") return `<em>${wrapped}</em>`;

    // Only an explicit link mark becomes an anchor. Anything else — a toolbar
    // mark this renderer hasn't learned, or a hand-written row — is ignored,
    // even when it happens to carry an `attrs.href`.
    if (mark.type !== "link") return wrapped;

    const attrs = asRecord(mark.attrs);
    const href = attrs?.href;
    if (typeof href !== "string" || !URL_PATTERN.test(href)) return wrapped;

    const target =
      attrs?.target === "_blank"
        ? ' target="_blank" rel="noopener noreferrer"'
        : "";
    return `<a href="${escapeHtml(href)}"${target}>${wrapped}</a>`;
  }, children);
};

const renderInline = (inline: Record<string, unknown>): string => {
  if (inline.type === "hardBreak") return "<br>";
  const text = inline.text;
  if (typeof text !== "string") return "";
  return renderMarks(inline.marks, escapeHtml(text));
};

const renderChildren = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content.map(renderContent).join("");
};

const renderNode = (node: Record<string, unknown>): string => {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderChildren(node.content)}</p>`;
    case "heading": {
      const level = asRecord(node.attrs)?.level;
      const tag = level === 3 ? "h3" : level === 4 ? "h4" : "h2";
      return `<${tag}>${renderChildren(node.content)}</${tag}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node.content)}</ul>`;
    case "orderedList": {
      // `start` has to be a real integer before it goes in the attribute:
      // anything else (a string, a float, a `1"` injection) is dropped, exactly
      // as the rest of the node set is closed.
      const start = asRecord(node.attrs)?.start;
      const attr =
        typeof start === "number" && Number.isInteger(start) && start > 1
          ? ` start="${start}"`
          : "";
      return `<ol${attr}>${renderChildren(node.content)}</ol>`;
    }
    case "listItem":
      return `<li>${renderChildren(node.content)}</li>`;
    default:
      // The node set is closed. Anything else is not rendered.
      return "";
  }
};

const renderContent = (content: unknown): string => {
  const node = asRecord(content);
  if (!node) return "";
  return node.type === "text" || node.type === "hardBreak"
    ? renderInline(node)
    : renderNode(node);
};

/**
 * Render a stored rich text document to an HTML fragment.
 *
 * The output is bare block elements with no wrapper: the caller places it where
 * the block's own template wants it. An empty, malformed or unreadable document
 * renders the empty string rather than throwing, so one bad field can't take
 * out the page around it.
 */
export const renderRichText = (document: RichTextDocument): string => {
  const node = asRecord(document);
  if (node?.type !== "doc") return "";
  return renderChildren(node.content);
};
