/**
 * The CMS form editor.
 *
 * This is the one place Billet CMS ships client JavaScript beyond nav chrome,
 * and the AGENTS.md exception says why: a rich text field is an editor, and an
 * editor is interactive by nature. Everything else about a CMS form is a plain
 * server-rendered form — the controls are generated from the block metadata and
 * the whole document rides in one hidden `content` field.
 *
 * The script is deliberately small and one-directional. It never fetches, never
 * parses JSON and never builds markup from data: the server renders the stored
 * content into the page (including the rich text as HTML), and this only walks
 * that DOM back into the hidden field on submit. With JavaScript off, the
 * hidden field submits the stored document unchanged, so a save still works.
 *
 * `boundaries.test.ts` enforces that: no `innerHTML`, no `JSON.parse`, no
 * `fetch`, no navigation. Keep it that way.
 */

interface RichTextMark {
  type: "bold" | "italic" | "link";
  attrs?: { href?: string; target?: string };
}

interface RichTextInline {
  type: "text" | "hardBreak";
  text?: string;
  marks?: RichTextMark[];
}

type RichTextNode = {
  type: "paragraph" | "heading" | "bulletList" | "orderedList" | "listItem";
  attrs?: { level?: number; start?: number };
  content?: (RichTextNode | RichTextInline)[];
};

const elementChildren = (node: Node): Element[] =>
  Array.from(node.childNodes).filter(
    (child): child is Element => child.nodeType === Node.ELEMENT_NODE,
  );

const inlineNodes = (node: Node, marks: RichTextMark[]): RichTextInline[] => {
  // A bare text node has no children to walk — it *is* the inline content (this
  // is how a `<li>one</li>` reaches here).
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text === "") return [];
    return [
      marks.length > 0 ? { type: "text", text, marks } : { type: "text", text },
    ];
  }

  const result: RichTextInline[] = [];

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (text === "") continue;
      result.push(
        marks.length > 0
          ? { type: "text", text, marks }
          : { type: "text", text },
      );
      continue;
    }

    if (!(child instanceof Element)) continue;
    const tag = child.tagName;

    if (tag === "BR") {
      result.push({ type: "hardBreak" });
      continue;
    }

    let nextMarks = marks;
    if (tag === "STRONG" || tag === "B") {
      nextMarks = [...marks, { type: "bold" }];
    } else if (tag === "EM" || tag === "I") {
      nextMarks = [...marks, { type: "italic" }];
    } else if (tag === "A") {
      const href = child.getAttribute("href") ?? "";
      const target = child.getAttribute("target");
      nextMarks = [
        ...marks,
        {
          type: "link",
          attrs: { href, ...(target ? { target } : {}) },
        },
      ];
    }

    result.push(...inlineNodes(child, nextMarks));
  }

  return result;
};

const paragraph = (node: Node): RichTextNode => {
  const content = inlineNodes(node, []);
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
};

/** A list item's children: block nodes, with any bare inline run wrapped in a paragraph. */
const listItemNode = (item: Element): RichTextNode => {
  const content: RichTextNode[] = [];
  let pending: Node[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const inline = pending.flatMap((node) => inlineNodes(node, []));
    if (inline.length > 0) content.push({ type: "paragraph", content: inline });
    pending = [];
  };

  for (const child of Array.from(item.childNodes)) {
    const isBlock =
      child instanceof Element &&
      ["P", "H2", "H3", "H4", "UL", "OL", "DIV"].includes(child.tagName);
    if (isBlock) {
      flush();
      for (const node of blockNodes(child as Element)) content.push(node);
    } else {
      pending.push(child);
    }
  }
  flush();

  return content.length > 0
    ? { type: "listItem", content }
    : { type: "listItem" };
};

const blockNodes = (root: Element): RichTextNode[] => {
  const result: RichTextNode[] = [];

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim() === "") continue;
      result.push(paragraph(child.parentNode ?? root));
      continue;
    }
    if (!(child instanceof Element)) continue;

    switch (child.tagName) {
      case "P":
      case "DIV":
        result.push(paragraph(child));
        break;
      case "H2":
        result.push({
          type: "heading",
          attrs: { level: 2 },
          content: inlineNodes(child, []),
        });
        break;
      case "H3":
        result.push({
          type: "heading",
          attrs: { level: 3 },
          content: inlineNodes(child, []),
        });
        break;
      case "H4":
        result.push({
          type: "heading",
          attrs: { level: 4 },
          content: inlineNodes(child, []),
        });
        break;
      case "UL":
        result.push({
          type: "bulletList",
          content: elementChildren(child)
            .filter((item) => item.tagName === "LI")
            .map(listItemNode),
        });
        break;
      case "OL": {
        const start = Number.parseInt(child.getAttribute("start") ?? "", 10);
        result.push({
          type: "orderedList",
          ...(Number.isSafeInteger(start) && start > 1
            ? { attrs: { start } }
            : {}),
          content: elementChildren(child)
            .filter((item) => item.tagName === "LI")
            .map(listItemNode),
        });
        break;
      }
      default:
        result.push(paragraph(child));
    }
  }

  return result;
};

export const serializeRichText = (root: Element): Record<string, unknown> => ({
  type: "doc",
  content: blockNodes(root),
});

const textValue = (control: Element): string | undefined => {
  const input = control.querySelector<HTMLInputElement>("[data-text-input]");
  const value = input?.value ?? "";
  return value === "" ? undefined : value;
};

const richTextValue = (control: Element): unknown => {
  const editor = control.querySelector<HTMLElement>("[data-rich-text]");
  return editor ? serializeRichText(editor) : undefined;
};

const imageValue = (control: Element): unknown => {
  const id =
    control.querySelector<HTMLInputElement>("[data-image-id]")?.value ?? "";
  if (id === "") return undefined;
  const alt =
    control.querySelector<HTMLInputElement>("[data-image-alt]")?.value ?? "";
  return alt === "" ? { mediaId: id } : { mediaId: id, alt };
};

const linkValue = (control: Element): unknown => {
  const type =
    control.querySelector<HTMLSelectElement>("[data-link-type]")?.value;
  const label =
    control.querySelector<HTMLInputElement>("[data-link-label]")?.value ?? "";
  const newTab =
    control.querySelector<HTMLInputElement>("[data-link-newtab]")?.checked ??
    false;

  if (type === "page") {
    const pageId =
      control.querySelector<HTMLInputElement>("[data-link-page]")?.value ?? "";
    if (pageId === "") return undefined;
    return {
      type: "page",
      pageId,
      ...(label ? { label } : {}),
      ...(newTab ? { newTab } : {}),
    };
  }

  const url =
    control.querySelector<HTMLInputElement>("[data-link-url]")?.value ?? "";
  if (url === "") return undefined;
  return {
    type: "url",
    url,
    ...(label ? { label } : {}),
    ...(newTab ? { newTab } : {}),
  };
};

const listValue = (control: Element): unknown[] => {
  const items = control.querySelectorAll(
    "[data-list-items] > [data-list-item]",
  );
  const values: unknown[] = [];
  for (const item of Array.from(items)) {
    const inner = item.querySelector("[data-field]");
    if (!inner) continue;
    const value = readControl(inner);
    if (value !== undefined) values.push(value);
  }
  return values;
};

const readControl = (control: Element): unknown => {
  switch (control.getAttribute("data-field-kind")) {
    case "text":
      return textValue(control);
    case "richText":
      return richTextValue(control);
    case "image":
      return imageValue(control);
    case "link":
      return linkValue(control);
    case "list":
      return listValue(control);
    default:
      return undefined;
  }
};

export const buildContent = (
  form: HTMLFormElement,
): Record<string, unknown> => {
  const content: Record<string, unknown> = {};
  for (const control of Array.from(form.querySelectorAll("[data-field]"))) {
    if (control.closest("[data-list-item]")) continue;
    const name = control.getAttribute("data-field-name");
    if (!name) continue;
    const value = readControl(control);
    if (value !== undefined) content[name] = value;
  }
  return content;
};

const runRichTextCommand = (command: string, editor: HTMLElement): void => {
  editor.focus();
  if (command === "bold") document.execCommand("bold");
  else if (command === "italic") document.execCommand("italic");
  else if (command === "h2") document.execCommand("formatBlock", false, "h2");
  else if (command === "h3") document.execCommand("formatBlock", false, "h3");
  else if (command === "h4") document.execCommand("formatBlock", false, "h4");
  else if (command === "paragraph")
    document.execCommand("formatBlock", false, "p");
  else if (command === "bulletList")
    document.execCommand("insertUnorderedList");
  else if (command === "orderedList") document.execCommand("insertOrderedList");
  else if (command === "link") {
    const href = window.prompt("Link URL");
    if (href) document.execCommand("createLink", false, href);
  }
};

const wireRichText = (form: HTMLFormElement): void => {
  for (const field of Array.from(
    form.querySelectorAll("[data-rich-text-field]"),
  )) {
    const editor = field.querySelector<HTMLElement>("[data-rich-text]");
    if (!editor) continue;
    for (const button of Array.from(
      field.querySelectorAll("[data-rich-command]"),
    )) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        runRichTextCommand(
          button.getAttribute("data-rich-command") ?? "",
          editor,
        );
      });
    }
  }
};

const wireLists = (form: HTMLFormElement): void => {
  for (const list of Array.from(form.querySelectorAll("[data-list]"))) {
    const items = list.querySelector("[data-list-items]");
    const template = list.querySelector<HTMLTemplateElement>(
      "[data-list-template]",
    );
    const max = Number.parseInt(list.getAttribute("data-max") ?? "", 10);

    list
      .querySelector("[data-list-add]")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        if (!items || !template) return;
        if (Number.isSafeInteger(max) && items.children.length >= max) return;
        items.append(template.content.cloneNode(true));
      });

    list.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const remove = target.closest("[data-list-remove]");
      if (!remove) return;
      event.preventDefault();
      remove.closest("[data-list-item]")?.remove();
    });
  }
};

const wireForm = (form: HTMLFormElement): void => {
  wireRichText(form);
  wireLists(form);

  form.addEventListener("submit", () => {
    const hidden = form.querySelector<HTMLInputElement>("[data-cms-content]");
    if (hidden) hidden.value = JSON.stringify(buildContent(form));
  });
};

export const init = (): void => {
  for (const form of Array.from(
    document.querySelectorAll<HTMLFormElement>("[data-cms-form]"),
  )) {
    wireForm(form);
  }
};

init();
