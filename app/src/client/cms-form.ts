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

import { narrowImageWarning } from "@shared/image-guidance";

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
  const newTab =
    control.querySelector<HTMLInputElement>("[data-link-newtab]")?.checked ??
    false;

  if (type === "page") {
    const pageId = inputValue("[data-link-page]");
    // Keep the page mode and label even with no page chosen yet, so a failed
    // save re-renders what the editor typed instead of resetting the field to a
    // URL link. A page-mode link that carries nothing at all is still dropped.
    if (pageId === "" && label === "" && !newTab) return undefined;
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
  if (destination === "") return undefined;
  return {
    type: "url",
    url: `${scheme}${destination}`,
    ...(label ? { label } : {}),
    ...(title ? { title } : {}),
    ...(newTab ? { newTab } : {}),
  };
};

/**
 * Drop every destination value the editor is not using when the link type
 * changes.
 *
 * A value typed for one type does not make sense for another — a path is not an
 * email — so carrying it into the newly selected input would save a destination
 * the editor never chose. The inputs are all server-rendered; this only clears
 * the ones the stylesheet is about to hide.
 */
const clearLinkDestinations = (field: Element, keep: string): void => {
  for (const destination of Array.from(
    field.querySelectorAll("[data-link-destination]"),
  )) {
    if (destination.getAttribute("data-link-destination") === keep) continue;
    const control = destination.querySelector<
      HTMLInputElement | HTMLSelectElement
    >("input, select");
    if (control) control.value = "";
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

/**
 * Grey out the Add button of every block type at its page-type maximum.
 *
 * The server counts every stored block, so the count here is every
 * `[data-cms-block]` of the type except one marked removed. The hint is
 * rendered by the server and only toggled with `hidden`. The "no blocks yet"
 * line follows the list the same way, so a block added in this tab hides it
 * before anything is saved.
 */
const syncBlockAdds = (container: Element | null): void => {
  const list = container?.querySelector(":scope > [data-cms-blocks]");
  if (!container || !list) return;
  const blocks = Array.from(
    list.querySelectorAll(":scope > [data-cms-block]"),
  ).filter((block) => !block.hasAttribute("data-block-removed"));
  const empty = container.querySelector<HTMLElement>("[data-cms-blocks-empty]");
  if (empty) empty.hidden = blocks.length > 0;
  for (const button of Array.from(
    container.querySelectorAll("[data-block-add][data-block-max]"),
  )) {
    const max = Number(button.getAttribute("data-block-max"));
    if (!Number.isFinite(max)) continue;
    const type = button.getAttribute("data-block-add");
    const count = blocks.filter(
      (block) => block.getAttribute("data-block-type") === type,
    ).length;
    const full = count >= max;
    if (full) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    const hintId = button.getAttribute("aria-describedby");
    const hint = hintId ? document.getElementById(hintId) : null;
    if (hint) {
      if (full) hint.removeAttribute("hidden");
      else hint.setAttribute("hidden", "");
    }
  }
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
 * Fill an image picker from the form's one reuse-list template.
 *
 * The server renders the upload options once, in a `<template
 * data-media-options>`, rather than in every image field: a page with many
 * image fields (and several list rows of them) would otherwise repeat the whole
 * library per control. A picker is filled the first time it is focused, so the
 * cost is paid only for a picker the editor actually reached. Its current image
 * is already an option there and may be older than the newest ones the template
 * lists; when the template does carry it, the option is relabelled from the
 * template so the picker shows a real label rather than a bare id, and the
 * stored value is not duplicated. A current image the editor gave a per-use alt
 * keeps that label — it is what the site renders for this use, and the library's
 * own alt would quietly replace it. The server marks such an option with
 * `data-media-keep-label`.
 */
const fillPickerFromOptions = (
  form: HTMLFormElement,
  picker: HTMLSelectElement,
): void => {
  if (picker.hasAttribute("data-media-filled")) return;
  const template = form.querySelector<HTMLTemplateElement>(
    "template[data-media-options]",
  );
  if (!template) return;
  picker.setAttribute("data-media-filled", "");

  const present = new Map(
    Array.from(
      picker.querySelectorAll("option"),
      (option) => [option.value, option] as const,
    ),
  );
  for (const option of Array.from(
    template.content.querySelectorAll("option"),
  )) {
    const existing = present.get(option.value);
    if (existing) {
      if (existing.hasAttribute("data-media-keep-label")) continue;
      existing.textContent = option.textContent;
      continue;
    }
    picker.append(option.cloneNode(true));
  }
};

/**
 * Show or clear an image field's too-narrow warning for the picked upload.
 *
 * Two numbers the server already rendered — the fieldset's `data-image-min-width`
 * and the option's `data-media-width` — are compared and a fixed sentence is
 * written into the slot beside the field. Nothing is fetched, parsed or built:
 * with JavaScript off the warning simply isn't shown while picking, and the
 * save's own notice (server-rendered after the redirect) still says it.
 */
const updateImageWarning = (
  field: Element,
  picker: HTMLSelectElement,
): void => {
  const warning = field.querySelector<HTMLElement>("[data-image-warning]");
  if (!warning) return;
  const minWidth = Number.parseInt(
    field.getAttribute("data-image-min-width") ?? "",
    10,
  );
  // `selectedOptions` rather than `value`, because an option's own width is what
  // matters and the picker's value can be an id the list no longer holds (a
  // hand-typed one, a deleted upload) with no option behind it.
  const option = Array.from(picker.options).find(
    (candidate) => candidate.value === picker.value,
  );
  const width = Number.parseInt(
    option?.getAttribute("data-media-width") ?? "",
    10,
  );
  if (
    !Number.isSafeInteger(minWidth) ||
    !Number.isSafeInteger(width) ||
    width >= minWidth
  ) {
    warning.hidden = true;
    warning.textContent = "";
    return;
  }
  warning.textContent = narrowImageWarning(width, minWidth);
  warning.hidden = false;
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

  // The image picker is a convenience over the media-id input, which stays the
  // field's value: choosing an upload writes its id there, and a hand-typed id
  // works exactly the same. With JavaScript off the picker isn't read at all.
  // `focusin` bubbles, so a picker cloned into a list row later is covered too;
  // it fills itself from the form's one options template the first time it is
  // focused.
  form.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const picker = target.closest("[data-image-picker]");
    if (picker instanceof HTMLSelectElement) {
      fillPickerFromOptions(form, picker);
    }
  });

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Switching a link's type drops the destination it is leaving behind. The
    // radio group is a real one, so this is the only place a type change needs
    // handling: the markup for every type is already on the page.
    const type = target.closest("[data-link-type]");
    if (type instanceof HTMLInputElement) {
      const field = type.closest("[data-field]");
      if (field) clearLinkDestinations(field, type.value);
      return;
    }

    const picker = target.closest("[data-image-picker]");
    if (!(picker instanceof HTMLSelectElement)) return;
    const field = picker.closest("[data-field]");
    if (!field) return;
    const input = field.querySelector<HTMLInputElement>("[data-image-id]");
    if (input) input.value = picker.value;
    updateImageWarning(field, picker);
  });

  // A hand-typed id carries no width, so whatever the picker said about the
  // image it had no longer describes the field. Clearing it is the honest
  // state; the save's own check still runs on the id that was typed.
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const input = target.closest("[data-image-id]");
    if (!(input instanceof HTMLInputElement)) return;
    const field = input.closest("[data-field]");
    const warning = field?.querySelector<HTMLElement>("[data-image-warning]");
    if (warning) {
      warning.hidden = true;
      warning.textContent = "";
    }
  });

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
      // A list nested inside the new row was cloned from an empty template, so
      // its own Add state has to be recomputed against the rows it now holds.
      syncListsIn(addedRow);
      firstControl(addedRow)?.focus();
      return;
    }

    const addBlock = target.closest("[data-block-add]");
    if (addBlock) {
      event.preventDefault();
      const container = addBlock.closest("[data-cms-page-content]");
      const list = container?.querySelector(":scope > [data-cms-blocks]");
      const type = addBlock.getAttribute("data-block-add");
      if (!container || !list || !type) return;
      // aria-disabled changes nothing on its own, so a click at the maximum
      // is refused here.
      if (addBlock.getAttribute("aria-disabled") === "true") return;

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
      // Lists inside the cloned block were rendered against an empty value; a
      // nested list already holding the template's one row, at max one, arrives
      // with an enabled Add.
      syncListsIn(added);
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

/**
 * A live "n / max" count under a length-limited text input.
 *
 * The input has no `maxlength`, so a long paste is kept rather than silently
 * cut; past the limit the server's own "Use N characters or fewer." line is
 * shown (the server renders it hidden) and the input is marked invalid.
 */
const wireCharCount = (form: HTMLFormElement): void => {
  // Delegated, so a text field in a list row or block added later is counted too.
  form.addEventListener("input", (event) => {
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) ||
      !input.hasAttribute("data-text-input")
    )
      return;
    const field = input.closest<HTMLElement>("[data-field]");
    const count = field?.querySelector<HTMLElement>("[data-char-count]");
    if (!field || !count) return;
    const max = Number(count.dataset.charMax);
    const length = input.value.length;
    count.textContent = `${length} / ${max}`;
    count.classList.toggle("cms-char-count-over", length > max);
    const over = field.querySelector<HTMLElement>("[data-char-over]");
    if (over) over.hidden = length <= max;
    if (length > max) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  });
};

const wireForm = (form: HTMLFormElement): void => {
  wireControls(form);
  wireFocalPoint(form);
  wireUrlMove(form);
  wireCharCount(form);

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
  for (const form of Array.from(
    document.querySelectorAll<HTMLFormElement>("[data-cms-form]"),
  )) {
    wireForm(form);
    syncBlockAdds(form.querySelector("[data-cms-page-content]"));
  }
};

init();
