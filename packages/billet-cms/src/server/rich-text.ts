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
import type {
  RichTextContent,
  RichTextDocument,
  RichTextInline,
  RichTextMark,
  RichTextNode,
} from "../fields/rich-text";
import { URL_PATTERN } from "../fields/url";

/** Escape a string for HTML text and for a quoted attribute value. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderMarks = (
  marks: RichTextMark[] | undefined,
  children: string,
): string => {
  if (!marks || marks.length === 0) return children;

  // Outermost mark first, so the nesting reads the same way the JSON lists it
  // and matches the CMS editor's own walker.
  return marks.reduceRight<string>((wrapped, mark) => {
    if (mark.type === "bold") return `<strong>${wrapped}</strong>`;
    if (mark.type === "italic") return `<em>${wrapped}</em>`;

    const href = mark.attrs?.href;
    if (typeof href !== "string" || !URL_PATTERN.test(href)) return wrapped;

    const target =
      mark.attrs?.target === "_blank"
        ? ' target="_blank" rel="noopener noreferrer"'
        : "";
    return `<a href="${escapeHtml(href)}"${target}>${wrapped}</a>`;
  }, children);
};

const renderInline = (inline: RichTextInline): string => {
  if (inline.type === "hardBreak") return "<br>";
  return renderMarks(inline.marks, escapeHtml(inline.text));
};

const renderChildren = (content: RichTextContent[] | undefined): string =>
  (content ?? []).map(renderContent).join("");

const renderNode = (node: RichTextNode): string => {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderChildren(node.content)}</p>`;
    case "heading": {
      const level = node.attrs?.level ?? 2;
      const tag = level === 3 ? "h3" : level === 4 ? "h4" : "h2";
      return `<${tag}>${renderChildren(node.content)}</${tag}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node.content)}</ul>`;
    case "orderedList": {
      const start = node.attrs?.start;
      const attr =
        start !== undefined && start !== 1 ? ` start="${start}"` : "";
      return `<ol${attr}>${renderChildren(node.content)}</ol>`;
    }
    case "listItem":
      return `<li>${renderChildren(node.content)}</li>`;
    default:
      // The node set is closed. Anything else is not rendered.
      return "";
  }
};

const renderContent = (content: RichTextContent): string =>
  content.type === "text" || content.type === "hardBreak"
    ? renderInline(content)
    : renderNode(content);

/**
 * Render a stored rich text document to an HTML fragment.
 *
 * The output is bare block elements with no wrapper: the caller places it where
 * the block's own template wants it. An empty or unreadable document renders
 * the empty string rather than throwing, so one bad field can't take out the
 * page around it.
 */
export const renderRichText = (document: RichTextDocument): string => {
  if (document?.type !== "doc") return "";
  return renderChildren(document.content);
};
