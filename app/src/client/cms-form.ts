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

/**
 * Walk a run of inline nodes, carrying the marks already open above them.
 *
 * Marks are read off each element as it is entered, so a `<strong>` nested in a
 * paragraph *or* sitting directly in a list item keeps its own mark. Flattening
 * each node through a fresh walk instead — the old bug — silently dropped the
 * mark of any inline element that was the first thing in the run.
 */
const inlineFromNodes = (
  nodes: Node[],
  marks: RichTextMark[],
): RichTextInline[] => {
  const result: RichTextInline[] = [];

  for (const child of nodes) {
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
        { type: "link", attrs: { href, ...(target ? { target } : {}) } },
      ];
    }

    result.push(...inlineFromNodes(Array.from(child.childNodes), nextMarks));
  }

  return result;
};

const inlineNodes = (node: Node, marks: RichTextMark[]): RichTextInline[] =>
  inlineFromNodes(Array.from(node.childNodes), marks);

const paragraph = (node: Node): RichTextNode => {
  const content = inlineNodes(node, []);
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
};

const BLOCK_TAGS = new Set(["P", "H2", "H3", "H4", "UL", "OL", "DIV"]);

const isListItem = (el: Element): boolean => el.tagName === "LI";

/** Serialize exactly one block element — the unit a list item's children are. */
const blockNode = (el: Element): RichTextNode => {
  switch (el.tagName) {
    case "H2":
    case "H3":
    case "H4":
      return {
        type: "heading",
        attrs: { level: Number(el.tagName[1]) },
        content: inlineNodes(el, []),
      };
    case "UL":
      return {
        type: "bulletList",
        content: elementChildren(el).filter(isListItem).map(listItemNode),
      };
    case "OL": {
      const start = Number.parseInt(el.getAttribute("start") ?? "", 10);
      return {
        type: "orderedList",
        ...(Number.isSafeInteger(start) && start > 1
          ? { attrs: { start } }
          : {}),
        content: elementChildren(el).filter(isListItem).map(listItemNode),
      };
    }
    default:
      return paragraph(el);
  }
};

/**
 * Collect the block nodes of a container, wrapping any bare inline run in a
 * paragraph of its own.
 *
 * The run is wrapped from its own nodes, never by re-walking the container:
 * re-walking a bare text node at the root is what duplicated the whole field.
 */
const blockNodes = (
  root: Element,
  into: RichTextNode[] = [],
): RichTextNode[] => {
  let pending: Node[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const inline = inlineFromNodes(pending, []);
    if (inline.length > 0) into.push({ type: "paragraph", content: inline });
    pending = [];
  };

  for (const child of Array.from(root.childNodes)) {
    if (child instanceof Element && BLOCK_TAGS.has(child.tagName)) {
      flush();
      into.push(blockNode(child));
    } else if (
      child.nodeType === Node.TEXT_NODE &&
      (child.textContent ?? "").trim() === ""
    ) {
      // Formatting whitespace between blocks is not content. Inside a paragraph
      // it would be — `inlineFromNodes` keeps it — but at block level it would
      // become a phantom empty paragraph.
    } else {
      pending.push(child);
    }
  }
  flush();

  return into;
};

/** A list item's children: block nodes, with any bare inline run wrapped in a paragraph. */
const listItemNode = (item: Element): RichTextNode => {
  const content = blockNodes(item);

  return content.length > 0
    ? { type: "listItem", content }
    : { type: "listItem" };
};

export const serializeRichText = (root: Element): Record<string, unknown> => ({
  type: "doc",
  content: blockNodes(root),
});

// A long field's textarea accepts a pasted line break, but the stored value is
// one plain line: each run of breaks becomes a single space. Saving and the
// live counter read the same string, so they never disagree at the limit.
const singleLine = (value: string): string => value.replace(/[\r\n]+/g, " ");

const textValue = (control: Element): string | undefined => {
  const input = control.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "[data-text-input]",
  );
  const raw = input?.value ?? "";
  const value = input instanceof HTMLTextAreaElement ? singleLine(raw) : raw;
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

/**
 * The stored value of a link control.
 *
 * Email and Phone are not types of their own in the stored shape: both are
 * `type: "url"` links whose scheme is what the editor recognises them by, so
 * the destination input holds the bare address and the prefix is added here
 * (and stripped again when the field is rendered).
 */
const linkValue = (control: Element): unknown => {
  const type =
    control.querySelector<HTMLInputElement>("[data-link-type]:checked")
      ?.value || "url";
  const inputValue = (selector: string): string =>
    control.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
      ?.value ?? "";
  const label = inputValue("[data-link-label]");
  const title = inputValue("[data-link-title]");
  // Email and Phone hide the New tab row, so a box ticked before switching type
  // must not be written onto a link that can't show it.
  const newTab =
    type === "email" || type === "phone"
      ? false
      : (control.querySelector<HTMLInputElement>("[data-link-newtab]")
          ?.checked ?? false);

  if (type === "page") {
    const pageId = inputValue("[data-link-page]");
    // Keep the page mode, label and hover text even with no page chosen yet, so
    // a failed save re-renders what the editor typed instead of resetting the
    // field to a URL link. A page-mode link that carries nothing at all is
    // still dropped.
    if (pageId === "" && label === "" && title === "" && !newTab) {
      return undefined;
    }
    return {
      type: "page",
      ...(pageId ? { pageId } : {}),
      ...(label ? { label } : {}),
      ...(title ? { title } : {}),
      ...(newTab ? { newTab } : {}),
    };
  }

  const scheme = type === "email" ? "mailto:" : type === "phone" ? "tel:" : "";
  const destination = inputValue(
    type === "email"
      ? "[data-link-email]"
      : type === "phone"
        ? "[data-link-phone]"
        : "[data-link-url]",
  );
  // The phone placeholder is written with spaces (`+44 20 7946 0000`); save the
  // canonical compact form so a number typed in the editor and one sent by MCP
  // or an import end up the same. The server accepts either.
  const stored =
    type === "phone" ? destination.replace(/\s+/g, "") : destination;
  if (stored === "") return undefined;
  return {
    type: "url",
    url: `${scheme}${stored}`,
    ...(label ? { label } : {}),
    ...(title ? { title } : {}),
    ...(newTab ? { newTab } : {}),
  };
};

/**
 * Give every link control in a cloned subtree its own radio-group name.
 *
 * A row or block is copied from a `<template>`, so the copy would share the
 * name of the row it came from — and every copy after it. The browser groups
 * inputs by name, so choosing a type in one row would uncheck it in another.
 * Names only have to differ, so a counter is enough; nothing reads them back
 * except the browser's own grouping.
 */
let clonedLinkGroup = 0;
const rescopeLinkRadios = (root: Element | null): void => {
  if (!root) return;
  const links = [
    ...(root.matches('[data-field-kind="link"]') ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-field-kind="link"]')),
  ];
  for (const link of links) {
    const name = `cms-link-type-${++clonedLinkGroup}`;
    for (const radio of Array.from(
      link.querySelectorAll<HTMLInputElement>("[data-link-type]"),
    )) {
      radio.name = name;
    }
  }
};

/**
 * True for a value that carries nothing, so an untouched list row is dropped.
 *
 * The server renders one empty row for a list so a required list has somewhere
 * to type. A text row read back as `undefined` falls away by itself, but an
 * untouched rich-text or nested-list row reads back as an empty document or an
 * empty array — truthy shapes that would otherwise become a phantom entry.
 */
const isEmptyDocument = (content: unknown): boolean => {
  if (!Array.isArray(content) || content.length === 0) return true;
  // The server gives an empty editor a trailing `<p>` to hold the caret, so an
  // untouched rich-text row reads back as a document of empty paragraphs.
  return content.every((node) => {
    const block = node as { type?: unknown; content?: unknown };
    return (
      block.type === "paragraph" &&
      (!Array.isArray(block.content) || block.content.length === 0)
    );
  });
};

const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (
    typeof value === "object" &&
    (value as { type?: unknown }).type === "doc"
  ) {
    return isEmptyDocument((value as { content?: unknown }).content);
  }
  // An untouched group: every control inside it read back as absent, so it has
  // no keys. Without this, adding a row to a list of groups and typing nothing
  // stores `{}` — an entry that counts towards the list's `min`/`max` and then
  // fails the block's schema on a field the editor never saw themselves leave
  // blank. Nothing else reads back as an empty object: an image with no id and
  // a text input with no value both return undefined.
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
};

const listValue = (control: Element): unknown[] => {
  // `:scope >` so a nested list's items are not read as this list's own; a
  // plain descendant selector matches them too, and one list would swallow the
  // other's rows.
  const container = control.querySelector(":scope > [data-list-items]");
  if (!container) return [];

  const values: unknown[] = [];
  for (const item of Array.from(
    container.querySelectorAll(":scope > [data-list-item]"),
  )) {
    const inner = item.querySelector(":scope > [data-field]");
    if (!inner) continue;
    const value = readControl(inner);
    if (!isEmptyValue(value)) values.push(value);
  }
  return values;
};

const groupValue = (control: Element): Record<string, unknown> => {
  // `:scope >` for the same reason the list uses it: a group nested in this one
  // has its own `[data-group-fields]`, and a descendant selector would read its
  // children as this group's as well.
  const container = control.querySelector(":scope > [data-group-fields]");
  if (!container) return {};

  const content: Record<string, unknown> = {};
  for (const child of Array.from(
    container.querySelectorAll(":scope > [data-field]"),
  )) {
    const name = child.getAttribute("data-field-name");
    if (!name) continue;
    const value = readControl(child);
    // Empty children are left out rather than written as blanks, so a group
    // whose controls were all untouched collapses to `{}` at every depth and
    // `isEmptyValue` can recognise it as the empty row it is.
    if (!isEmptyValue(value)) content[name] = value;
  }
  return content;
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
    case "group":
      return groupValue(control);
    default:
      return undefined;
  }
};

/**
 * Read the field controls in a scope into a block's content object.
 *
 * `excludeBlocks` is for the slot form, whose fields sit at the top level: a
 * page form's block fields would otherwise be read twice — once here and once
 * per block below.
 */
const readFieldsIn = (
  scope: Element,
  excludeBlocks: boolean,
): Record<string, unknown> => {
  const content: Record<string, unknown> = {};
  for (const control of Array.from(scope.querySelectorAll("[data-field]"))) {
    if (control.closest("[data-list-item]")) continue;
    // A group's children are `[data-field]` too, and `groupValue` has already
    // read them into the group's own object. Without this they would also land
    // at the top level under their own names — content the block's schema
    // rejects, from a form that looked right.
    if (control.closest("[data-group-fields]")) continue;
    if (excludeBlocks && control.closest("[data-cms-block]")) continue;
    const name = control.getAttribute("data-field-name");
    if (!name) continue;
    const value = readControl(control);
    if (value !== undefined) content[name] = value;
  }
  return content;
};

export const buildContent = (form: HTMLFormElement): Record<string, unknown> =>
  readFieldsIn(form, true);

/**
 * Read a page form into `{ blocks: [...] }`.
 *
 * One entry per `[data-cms-block]` the editor kept, in the order they appear.
 * A block with nothing in it — one added and left alone — is dropped rather
 * than saved as an empty block. A block the server flagged as unavailable has
 * no controls and no `data-field`s; it is skipped here and carried through by
 * the write layer, so a deploy's removed block is never lost by a save.
 */
export const buildPageContent = (
  form: HTMLFormElement,
): Record<string, unknown> => ({ blocks: readPageBlocks(form).blocks });

const readPageBlocks = (
  form: HTMLFormElement,
): { blocks: Record<string, unknown>[]; dropped: string[] } => {
  const container = form.querySelector("[data-cms-page-content]");
  const list = container?.querySelector(":scope > [data-cms-blocks]");
  const blocks: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  if (!list) return { blocks, dropped };

  for (const block of Array.from(
    list.querySelectorAll(":scope > [data-cms-block]"),
  )) {
    if (block.hasAttribute("data-block-unavailable")) continue;
    const type = block.getAttribute("data-block-type");
    if (!type) continue;
    const fields = readFieldsIn(block, false);
    if (!Object.values(fields).some((value) => !isEmptyValue(value))) {
      dropped.push(type);
      continue;
    }
    blocks.push({ type, ...fields });
  }

  return { blocks, dropped };
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

/** The first control a keyboard user lands on when focusing a list row. */
const FOCUSABLE = "input, select, textarea, button, [contenteditable], a[href]";

const firstControl = (row: Element | null): HTMLElement | null =>
  row ? row.querySelector<HTMLElement>(FOCUSABLE) : null;

/** The rows container and parsed maximum of a list element. */
const listRows = (list: Element): Element | null =>
  list.querySelector(":scope > [data-list-items]");

const listMax = (list: Element): number | null => {
  const max = Number.parseInt(list.getAttribute("data-max") ?? "", 10);
  return Number.isSafeInteger(max) ? max : null;
};

/** A list at its maximum can't take another row. */
const canAddRow = (list: Element, items: Element): boolean => {
  const max = listMax(list);
  return max === null || items.children.length < max;
};

/**
 * Keep the Add button's disabled state in step with the row count.
 *
 * The server renders it `aria-disabled` when the stored content is already at
 * the maximum; this covers every Add and Remove after that. It is a state, not
 * a `disabled` attribute, so the button stays focusable and clickable and the
 * guard in the click handler is what actually refuses the extra row — a
 * programmatic click ignores `aria-disabled` just as it ignores `disabled`.
 */
const syncListAdd = (list: Element, items?: Element | null): void => {
  const add = list.querySelector<HTMLButtonElement>(":scope > [data-list-add]");
  if (!add) return;
  const max = listMax(list);
  if (max === null) {
    add.removeAttribute("aria-disabled");
    return;
  }
  const container = items ?? listRows(list);
  if ((container?.children.length ?? 0) >= max) {
    add.setAttribute("aria-disabled", "true");
  } else {
    add.removeAttribute("aria-disabled");
  }
};

/**
 * Bring every list in a subtree — the element itself included — in step.
 *
 * A row or block is cloned from a `<template>`, and a list inside it was
 * rendered against the template's empty value. A nested list whose maximum is
 * one therefore arrives with a row and an enabled Add, so the clone has to be
 * re-synced rather than trusted.
 */
const syncListsIn = (root: Element | null): void => {
  if (!root) return;
  const lists = root.matches("[data-list]")
    ? [root, ...Array.from(root.querySelectorAll("[data-list]"))]
    : Array.from(root.querySelectorAll("[data-list]"));
  for (const list of lists) syncListAdd(list);
};

const blockAddToggle = (area: Element): HTMLButtonElement | null =>
  area.querySelector<HTMLButtonElement>("[data-block-add-toggle]");

const blockAddMenu = (area: Element): HTMLElement | null =>
  area.querySelector<HTMLElement>("[data-block-add-menu]");

/** The menu's items the editor can currently pick. */
const blockAddItems = (menu: Element): HTMLButtonElement[] =>
  Array.from(
    menu.querySelectorAll<HTMLButtonElement>("[data-block-add]"),
  ).filter((item) => !item.hidden);

const closeBlockAddMenu = (area: Element, returnFocus = false): void => {
  const menu = blockAddMenu(area);
  if (menu) menu.hidden = true;
  const toggle = blockAddToggle(area);
  toggle?.setAttribute("aria-expanded", "false");
  if (returnFocus) toggle?.focus();
};

/**
 * Open the menu on its first item.
 *
 * A type at its page-type maximum has been hidden by `syncBlockAdds`, so an
 * empty menu means nothing can be added: the toggle does nothing rather than
 * opening an empty panel.
 */
const openBlockAddMenu = (area: Element): void => {
  const menu = blockAddMenu(area);
  const toggle = blockAddToggle(area);
  if (!menu || !toggle) return;
  const items = blockAddItems(menu);
  if (items.length === 0) return;
  menu.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  items[0]?.focus();
};

const toggleBlockAddMenu = (area: Element): void => {
  if (blockAddToggle(area)?.getAttribute("aria-expanded") === "true") {
    closeBlockAddMenu(area);
  } else {
    openBlockAddMenu(area);
  }
};

/**
 * Keep the Add block menu in step with the blocks on the page.
 *
 * The server counts every stored block, so the count here is every
 * `[data-cms-block]` of the type except one marked removed. A type at its
 * page-type maximum is hidden rather than removed, because removing the last
 * block of that type has to bring it back. When no item is left the whole
 * control is hidden, so nothing explains a limit. The "no blocks yet" line
 * follows the list the same way, so a block added in this tab hides it before
 * anything is saved.
 */
const syncBlockAdds = (container: Element | null): void => {
  const list = container?.querySelector(":scope > [data-cms-blocks]");
  if (!container || !list) return;
  const blocks = Array.from(
    list.querySelectorAll(":scope > [data-cms-block]"),
  ).filter((block) => !block.hasAttribute("data-block-removed"));
  const empty = container.querySelector<HTMLElement>("[data-cms-blocks-empty]");
  if (empty) empty.hidden = blocks.length > 0;

  const area = container.querySelector<HTMLElement>("[data-block-add-area]");
  const menu = area ? blockAddMenu(area) : null;
  if (!area || !menu) return;

  let addable = 0;
  for (const item of Array.from(
    menu.querySelectorAll<HTMLElement>("[data-block-add]"),
  )) {
    const type = item.getAttribute("data-block-add");
    const maxText = item.getAttribute("data-block-max");
    const max = maxText === null ? null : Number.parseInt(maxText, 10);
    const count = blocks.filter(
      (block) => block.getAttribute("data-block-type") === type,
    ).length;
    const full = max !== null && Number.isSafeInteger(max) && count >= max;
    item.hidden = full;
    if (!full) addable += 1;
  }

  // An open menu must not outlive the item that had focus, and a control with
  // nothing left to offer is hidden entirely.
  if (addable === 0) closeBlockAddMenu(area);
  area.hidden = addable === 0;
};

/**
 * Record a flagged block's removal in the form's `removed_blocks` field.
 *
 * A flagged block has no field controls, so the client can't rebuild it into
 * the hidden `content` field; removing it has to be an explicit marker instead.
 * The index is the block's position in the revision the editor loaded — the
 * same index the server's carry-back uses to put an uneditable block back. The
 * block is hidden rather than detached so the marker stays with it until submit.
 */
const markBlockRemoved = (form: HTMLFormElement, block: Element): void => {
  const index = Number.parseInt(
    block.getAttribute("data-block-index") ?? "",
    10,
  );
  const hidden = form.querySelector<HTMLInputElement>("[data-cms-removed]");
  if (hidden && Number.isSafeInteger(index) && index >= 0) {
    const indexes = hidden.value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (!indexes.includes(String(index))) indexes.push(String(index));
    hidden.value = indexes.join(",");
  }
  block.setAttribute("data-block-removed", "");
  block.setAttribute("hidden", "");
};

/**
 * Wire the rich text toolbars and the repeatable lists through one delegated
 * listener on the form.
 *
 * A per-button or per-list listener only reaches the controls present when the
 * page loaded — the toolbar or nested list inside a row the editor just added
 * would have none, so its own buttons would do nothing. Delegation from the
 * form covers a control however deep it is cloned. Each button is resolved
 * against its nearest `[data-rich-text-field]`/`[data-list]`, and `:scope >`
 * keeps a nested list from answering for its parent's items, template or Add
 * button.
 */
const wireControls = (form: HTMLFormElement): void => {
  // A list whose stored content already sits at its maximum ships with Add
  // disabled; this brings every list in step before any interaction.
  for (const list of Array.from(form.querySelectorAll("[data-list]"))) {
    syncListAdd(list);
  }

  form.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const command = target.closest("[data-rich-command]");
    if (command) {
      event.preventDefault();
      const field = command.closest("[data-rich-text-field]");
      const editor = field?.querySelector<HTMLElement>("[data-rich-text]");
      if (editor) {
        runRichTextCommand(
          command.getAttribute("data-rich-command") ?? "",
          editor,
        );
      }
      return;
    }

    const add = target.closest("[data-list-add]");
    if (add) {
      event.preventDefault();
      const list = add.closest("[data-list]");
      if (!list) return;

      const items = listRows(list);
      const template = list.querySelector<HTMLTemplateElement>(
        ":scope > [data-list-template]",
      );
      if (!items || !template) return;

      // The button is aria-disabled at the maximum, but a programmatic click
      // ignores that, so the guard stays.
      if (!canAddRow(list, items)) return;
      items.append(template.content.cloneNode(true));
      syncListAdd(list, items);
      const addedRow = items.lastElementChild;
      rescopeLinkRadios(addedRow);
      // A list nested inside the new row was cloned from an empty template, so
      // its own Add state has to be recomputed against the rows it now holds.
      syncListsIn(addedRow);
      // A long text field arrives at its rendered three rows; size it now so
      // the first character typed does not jump the box.
      growTextAreasIn(addedRow);
      firstControl(addedRow)?.focus();
      return;
    }

    const toggle = target.closest("[data-block-add-toggle]");
    if (toggle) {
      event.preventDefault();
      const area = toggle.closest("[data-block-add-area]");
      if (area) toggleBlockAddMenu(area);
      return;
    }

    const addBlock = target.closest("[data-block-add]");
    if (addBlock) {
      event.preventDefault();
      const container = addBlock.closest("[data-cms-page-content]");
      const list = container?.querySelector(":scope > [data-cms-blocks]");
      const type = addBlock.getAttribute("data-block-add");
      if (!container || !list || !type) return;
      // A type at its maximum is hidden from the menu, but a programmatic
      // click ignores `hidden` as it did `aria-disabled`, so the guard stays.
      if (addBlock.hasAttribute("hidden")) return;

      // Matched by attribute rather than a selector: the block name could
      // contain a character a CSS selector would read as syntax, and iterating
      // a handful of templates costs nothing.
      const template = Array.from(
        container.querySelectorAll<HTMLTemplateElement>(
          "template[data-cms-block-template]",
        ),
      ).find((candidate) => candidate.getAttribute("data-block-type") === type);
      if (!template) return;

      list.append(template.content.cloneNode(true));
      const added = list.lastElementChild;
      rescopeLinkRadios(added);
      // Lists inside the cloned block were rendered against an empty value; a
      // nested list already holding the template's one row, at max one, arrives
      // with an enabled Add.
      syncListsIn(added);
      growTextAreasIn(added);
      // The picked type may now be at its maximum: close the menu and drop it
      // from the list before focus moves into the new block.
      const area = addBlock.closest("[data-block-add-area]");
      if (area) closeBlockAddMenu(area);
      syncBlockAdds(container);
      // `:scope >` so a nested control (a list row) is not what gets focused.
      firstControl(added)?.focus();
      return;
    }

    const removeBlock = target.closest("[data-block-remove]");
    if (removeBlock) {
      event.preventDefault();
      const block = removeBlock.closest("[data-cms-block]");
      if (!block) return;
      const pageContent = block.closest("[data-cms-page-content]");
      // A flagged block is uneditable, so its removal is recorded as a marker
      // rather than by serializing it; everything else is simply detached.
      if (block.hasAttribute("data-block-unavailable")) {
        markBlockRemoved(form, block);
      } else {
        block.remove();
      }
      syncBlockAdds(pageContent);
      return;
    }

    const moveUp = target.closest("[data-block-up]");
    if (moveUp) {
      event.preventDefault();
      const block = moveUp.closest("[data-cms-block]");
      const previous = block?.previousElementSibling;
      if (block && previous) {
        block.parentElement?.insertBefore(block, previous);
        firstControl(block)?.focus();
      }
      return;
    }

    const moveDown = target.closest("[data-block-down]");
    if (moveDown) {
      event.preventDefault();
      const block = moveDown.closest("[data-cms-block]");
      const next = block?.nextElementSibling;
      if (block && next) {
        block.parentElement?.insertBefore(next, block);
        firstControl(block)?.focus();
      }
      return;
    }

    const remove = target.closest("[data-list-remove]");
    if (!remove) return;
    event.preventDefault();

    const item = remove.closest("[data-list-item]");
    if (!item) return;
    const list = item.closest("[data-list]");

    // Where focus goes once the row is gone: the first control of the next row,
    // else the previous row, else the list's Add button. Reading the siblings
    // before the removal is what makes "next" and "previous" mean the rows
    // around it rather than nothing (the row is detached afterwards).
    const next = item.nextElementSibling;
    const previous = item.previousElementSibling;
    item.remove();
    if (list) syncListAdd(list);

    const nextFocus: HTMLElement | null | undefined =
      firstControl(next) ??
      firstControl(previous) ??
      // `:scope >` avoids a nested list's Add button.
      list?.querySelector<HTMLElement>(":scope > [data-list-add]");
    nextFocus?.focus();
  });

  // The menu's own keys. Enter and Space are handled here rather than left to
  // the browser's button activation, because canceling the keydown is what
  // keeps a real Enter from also firing the native click and adding twice.
  form.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const area = target.closest("[data-block-add-area]");
    if (!area) return;
    const button = target.closest<HTMLElement>(
      "[data-block-add-toggle], [data-block-add]",
    );
    if (button && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      button.click();
      return;
    }

    const menu = blockAddMenu(area);
    if (!menu || menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeBlockAddMenu(area, true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const item = target.closest("[data-block-add]");
    if (!item) return;
    const items = blockAddItems(menu);
    const index = items.indexOf(item as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  });
};

/**
 * Close an open Add block menu when the click lands outside its control.
 *
 * One listener for the document rather than one per form: `init` runs again
 * after any markup replacement, and a per-form listener would pile up. A click
 * on the toggle or an item is inside the control, so the form's own handler
 * has already done its work by the time this runs.
 */
let outsideClickWired = false;
const wireOutsideClick = (): void => {
  if (outsideClickWired) return;
  outsideClickWired = true;
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    for (const menu of Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-block-add-menu]:not([hidden])",
      ),
    )) {
      const area = menu.closest("[data-block-add-area]");
      if (area && !area.contains(target)) closeBlockAddMenu(area);
    }
  });
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A hidden focal input's value as a fraction, defaulting to the centre. */
const readFraction = (input: HTMLInputElement): number => {
  const value = Number(input.value);
  return Number.isFinite(value) ? clamp01(value) : 0.5;
};

/**
 * Wire the focal-point picker on a media detail form.
 *
 * The picture is a click target and a keyboard one (arrows nudge by one percent,
 * Shift by ten): both only move the marker and the three previews, and write the
 * fraction into the form's hidden `focal_x`/`focal_y` inputs. No markup is built
 * and nothing is fetched — the server already rendered every element, and with
 * JavaScript off the inputs keep whatever was last saved.
 */
const wireFocalPoint = (form: HTMLFormElement): void => {
  const picker = form.querySelector<HTMLElement>("[data-focal-picker]");
  const xInput = form.querySelector<HTMLInputElement>("[data-focal-x]");
  const yInput = form.querySelector<HTMLInputElement>("[data-focal-y]");
  if (!picker || !xInput || !yInput) return;

  const marker = form.querySelector<HTMLElement>("[data-focal-marker]");
  const previews = Array.from(
    form.querySelectorAll<HTMLElement>("[data-focal-preview]"),
  );

  const apply = (x: number, y: number): void => {
    const roundedX = Math.round(x * 1000) / 1000;
    const roundedY = Math.round(y * 1000) / 1000;
    xInput.value = String(roundedX);
    yInput.value = String(roundedY);
    if (marker) {
      marker.style.left = `${roundedX * 100}%`;
      marker.style.top = `${roundedY * 100}%`;
    }
    const position = `${roundedX * 100}% ${roundedY * 100}%`;
    for (const preview of previews) preview.style.objectPosition = position;
  };

  picker.addEventListener("click", (event) => {
    // A keyboard "click" on the button — Enter or Space — arrives with no
    // pointer coordinates (`detail === 0`, clientX/Y both 0), which would set
    // the focal point to the top-left. Only a real pointer press moves it.
    if (event.detail === 0) return;
    const rect = picker.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    apply(
      clamp01((event.clientX - rect.left) / rect.width),
      clamp01((event.clientY - rect.top) / rect.height),
    );
  });

  picker.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    let x = readFraction(xInput);
    let y = readFraction(yInput);

    if (event.key === "ArrowLeft") x = clamp01(x - step);
    else if (event.key === "ArrowRight") x = clamp01(x + step);
    else if (event.key === "ArrowUp") y = clamp01(y - step);
    else if (event.key === "ArrowDown") y = clamp01(y + step);
    else return;

    event.preventDefault();
    apply(x, y);
  });
};

/**
 * Shows the "Publishing moves this page" line while the URL input differs from
 * the live one, and names the typed URL in it as the editor types.
 */
const wireUrlMove = (form: HTMLFormElement): void => {
  const input = form.querySelector<HTMLInputElement>("[data-url-live]");
  const line = form.querySelector<HTMLElement>("[data-url-move]");
  if (!input || !line) return;
  const to = form.querySelector<HTMLElement>("[data-url-move-to]");
  // The server's own spelling of a path (leading slash, no doubled or trailing
  // slashes), so `/about/` doesn't claim a move the save won't make.
  const update = (): void => {
    const value = input.value.trim();
    const typed = `/${value}`.replace(/\/{2,}/g, "/");
    const url = typed.replace(/\/$/, "") || "/";
    // An emptied field is not a move to the root: the server refuses "" before
    // it ever gets that far, so the line stays hidden.
    line.hidden = value === "" || url === input.dataset.urlLive;
    if (to) to.textContent = url;
  };
  input.addEventListener("input", update);
  update();
};

/** The width each grown box was measured at, so a height change alone is ignored. */
const grownWidths = new WeakMap<HTMLTextAreaElement, number>();

/** One resize observer per form, so a box cloned into it is watched too. */
const areaObservers = new WeakMap<Element, ResizeObserver>();

/**
 * Size a long text field's box to the text in it.
 *
 * The `cms-textarea-grown` class is added only here, after the box has been
 * measured, because the stylesheet hangs `overflow: hidden` and the dropped
 * resize handle on it: with JavaScript off the class never arrives and the
 * textarea keeps its scrollbar, so stored long text is never clipped.
 */
const growTextArea = (area: HTMLTextAreaElement): void => {
  // A box in a hidden section (a collapsed <details>, a hidden panel) has no
  // layout box, so every measurement is zero: growing it there would pin it to
  // no height with no scrollbar. Leave it alone; the resize observer below
  // grows it once it is shown and gets a width.
  if (area.getClientRects().length === 0) return;
  grownWidths.set(area, area.clientWidth);
  area.classList.add("cms-textarea-grown");
  area.style.height = "auto";
  // The controls are `box-sizing: border-box`, and `scrollHeight` excludes the
  // border: without it the last couple of pixels of a descender are clipped.
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
};

/** Grow every long text field in a subtree, e.g. a row or block just cloned. */
const growTextAreasIn = (root: ParentNode | null): void => {
  if (!root) return;
  const form = root instanceof Element ? root.closest("form") : null;
  const observer = form === null ? undefined : areaObservers.get(form);
  for (const area of Array.from(
    root.querySelectorAll<HTMLTextAreaElement>("textarea[data-text-input]"),
  )) {
    growTextArea(area);
    observer?.observe(area);
  }
};

/**
 * Wire the long text fields: grow on first paint and while typing, and keep
 * Enter from adding a break — the field stores one plain line.
 *
 * The box is sized in pixels, and text re-wraps to more lines when its column
 * narrows (the window resized, a phone rotated, a web font loaded), so the
 * observer re-grows it whenever its width changes. A width change is also what
 * a `<details>` opening produces, which is how a box that arrived with no
 * layout box gets grown.
 */
const wireTextAreas = (form: HTMLFormElement): void => {
  if (typeof ResizeObserver !== "undefined") {
    areaObservers.set(
      form,
      new ResizeObserver((entries) => {
        for (const { target } of entries) {
          const area = target as HTMLTextAreaElement;
          if (area.clientWidth !== grownWidths.get(area)) growTextArea(area);
        }
      }),
    );
  }
  growTextAreasIn(form);

  form.addEventListener("input", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLTextAreaElement &&
      target.hasAttribute("data-text-input")
    ) {
      growTextArea(target);
    }
  });

  form.addEventListener("keydown", (event) => {
    const target = event.target;
    // `isComposing` lets Enter commit an IME composition rather than swallow it.
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      target instanceof HTMLTextAreaElement &&
      target.hasAttribute("data-text-input")
    ) {
      event.preventDefault();
    }
  });
};

/**
 * A live "n / max" count under a length-limited text input or textarea.
 *
 * The control has no `maxlength`, so a long paste is kept rather than silently
 * cut; past the limit the server's own "Use N characters or fewer." line is
 * shown (the server renders it hidden) and the control is marked invalid.
 */
const wireCharCount = (form: HTMLFormElement): void => {
  // Delegated, so a text field in a list row or block added later is counted too.
  form.addEventListener("input", (event) => {
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) &&
      !(input instanceof HTMLTextAreaElement)
    )
      return;
    if (!input.hasAttribute("data-text-input")) return;
    const field = input.closest<HTMLElement>("[data-field]");
    const count = field?.querySelector<HTMLElement>("[data-char-count]");
    if (!field || !count) return;
    const max = Number(count.dataset.charMax);
    // Count what the save will store, not the raw box: a pasted run of breaks
    // is one space there, so the live over-limit state agrees with the server.
    const length = (
      input instanceof HTMLTextAreaElement
        ? singleLine(input.value)
        : input.value
    ).length;
    count.textContent = `${length} / ${max}`;
    count.classList.toggle("cms-char-count-over", length > max);
    const over = field.querySelector<HTMLElement>("[data-char-over]");
    if (over) over.hidden = length <= max;
    if (length > max) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  });
};

/**
 * Clear a field's server-rendered error as soon as the editor fixes its value.
 *
 * A refused save re-renders the offending control with `aria-invalid` and the
 * server's message under it. Nothing reloads as the editor types, so without
 * this the red stayed on a field that was now right. The error list belongs to
 * the control group the change landed in — a link's button text, its hover text
 * and its destination each carry their own — so fixing one leaves the other
 * fields' errors alone.
 *
 * A length error waits until the count is back within the limit: typing from
 * one character over to two over has not fixed it, and the counter's own
 * over-limit state is the honest warning until it is. Once it is within, the
 * server's message goes and the counter takes over again if the editor passes
 * the limit once more.
 */
const wireFieldErrors = (form: HTMLFormElement): void => {
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // A link is one field with three error lists; the nearest wrapping part is
    // the one the editor changed. The type switch's group has no list of its
    // own, so flipping it clears nothing.
    const linkPart = target.closest(
      ".cms-link-text, .cms-link-title, .cms-link-destination, .cms-link-destination-group",
    );
    // A block image field's picker is a `.cms-field` inside the field it
    // belongs to, so the field wins; a page setting's picker is its own field.
    const scope =
      linkPart ??
      target.closest("[data-field]") ??
      target.closest(".cms-field");
    if (!scope) return;

    const input = scope.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "[data-text-input]",
    );
    const count = scope.querySelector<HTMLElement>("[data-char-count]");
    const max = Number(count?.dataset.charMax);
    if (input && Number.isSafeInteger(max)) {
      // The same string the save stores and the live counter shows.
      const length = (
        input instanceof HTMLTextAreaElement
          ? singleLine(input.value)
          : input.value
      ).length;
      if (length > max) return;
    }

    // The counter's own over-limit line is a `.cms-field-errors` too, and the
    // server does not render it beside a server error — so this clears the
    // server's list even after the count has already dropped `aria-invalid`.
    const errors = Array.from(
      scope.querySelectorAll(".cms-field-errors:not([data-char-over])"),
    );
    const invalid = scope.hasAttribute("aria-invalid")
      ? [scope, ...Array.from(scope.querySelectorAll("[aria-invalid]"))]
      : Array.from(scope.querySelectorAll("[aria-invalid]"));
    if (errors.length === 0 && invalid.length === 0) return;
    for (const error of errors) error.remove();
    for (const control of invalid) control.removeAttribute("aria-invalid");
  });
};

const wireForm = (form: HTMLFormElement): void => {
  wireControls(form);
  wireFocalPoint(form);
  wireUrlMove(form);
  wireCharCount(form);
  wireFieldErrors(form);
  wireTextAreas(form);

  form.addEventListener("submit", () => {
    const hidden = form.querySelector<HTMLInputElement>("[data-cms-content]");
    if (!hidden) return;
    // A page form's content is `{ blocks: [...] }`; a slot form's is its fields.
    if (form.querySelector("[data-cms-page-content]")) {
      const { blocks, dropped } = readPageBlocks(form);
      hidden.value = JSON.stringify({ blocks });
      // Tell the server which empty blocks were left out, so it can say so.
      const droppedField =
        form.querySelector<HTMLInputElement>("[data-cms-dropped]");
      if (droppedField) droppedField.value = dropped.join(",");
    } else {
      hidden.value = JSON.stringify(buildContent(form));
    }
  });
};

export const init = (): void => {
  wireOutsideClick();
  for (const form of Array.from(
    document.querySelectorAll<HTMLFormElement>("[data-cms-form]"),
  )) {
    wireForm(form);
    syncBlockAdds(form.querySelector("[data-cms-page-content]"));
  }
};

init();
