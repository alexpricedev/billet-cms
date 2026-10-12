import type {
  RichTextContent,
  RichTextDocument,
  RichTextInline,
  RichTextMark,
  RichTextNode,
} from "@alexpricedev/billet-cms/fields";
import type { ComponentChildren, JSX } from "preact";

/**
 * Render a stored rich text document to editable HTML.
 *
 * The document is structured JSON (Q1), restricted to paragraphs, `h2`-`h4`,
 * bullet and ordered lists, links, bold and italic. The schema the site
 * published already refuses anything else, so this walker has no fallback
 * branch for an unknown node: by the time a revision is stored, its shape is
 * one of the cases below.
 *
 * Rendering the value on the server, inside the form, is what lets the editor
 * work without the browser ever parsing JSON: the stored document becomes DOM
 * in the page, and the editor's only job is to walk that DOM back out on save.
 */

const renderMarks = (
  marks: RichTextMark[] | undefined,
  children: ComponentChildren,
): ComponentChildren => {
  if (!marks || marks.length === 0) return children;

  // Outermost mark first, so the rendered nesting reads the same way the JSON
  // lists them and a round trip through the editor returns them in that order.
  return marks.reduceRight<ComponentChildren>((wrapped, mark) => {
    if (mark.type === "bold") return <strong>{wrapped}</strong>;
    if (mark.type === "italic") return <em>{wrapped}</em>;
    return (
      <a
        href={mark.attrs?.href}
        {...(mark.attrs?.target ? { target: mark.attrs.target } : {})}
      >
        {wrapped}
      </a>
    );
  }, children);
};

const renderInline = (inline: RichTextInline): ComponentChildren => {
  if (inline.type === "hardBreak") return <br />;
  return renderMarks(inline.marks, inline.text);
};

const renderNode = (node: RichTextNode): ComponentChildren => {
  switch (node.type) {
    case "paragraph":
      return <p>{node.content?.map(renderContent)}</p>;
    case "heading": {
      const children = node.content?.map(renderContent);
      const level = node.attrs?.level ?? 2;
      if (level === 3) return <h3>{children}</h3>;
      if (level === 4) return <h4>{children}</h4>;
      return <h2>{children}</h2>;
    }
    case "bulletList":
      return <ul>{node.content?.map(renderContent)}</ul>;
    case "orderedList":
      return (
        <ol start={node.attrs?.start}>{node.content?.map(renderContent)}</ol>
      );
    case "listItem":
      return <li>{node.content?.map(renderContent)}</li>;
  }
};

const renderContent = (
  content: RichTextContent | RichTextInline,
): ComponentChildren =>
  content.type === "text" || content.type === "hardBreak"
    ? renderInline(content)
    : renderNode(content);

export interface RichTextViewProps {
  document: RichTextDocument;
}

/** The editable body of a rich text field. */
export const RichTextView = ({ document }: RichTextViewProps): JSX.Element => (
  <>
    {document.content?.map(renderContent)}
    {/* contenteditable collapses to nothing without a last block; a trailing
        paragraph preserves the caret position after the final block. */}
    {(!document.content || document.content.length === 0) && <p />}
  </>
);
