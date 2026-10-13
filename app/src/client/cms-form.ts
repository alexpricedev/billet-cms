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
      control.querySelector<HTMLInputElement | HTMLSelectElement>(
        "[data-link-page]",
      )?.value ?? "";
    // Keep the page mode and label even with no page chosen yet, so a failed
    // save re-renders what the editor typed instead of resetting the field to a
    // URL link. A page-mode link that carries nothing at all is still dropped.
    if (pageId === "" && label === "" && !newTab) return undefined;
    return {
      type: "page",
      ...(pageId ? { pageId } : {}),
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
): Record<string, unknown> => {
  const container = form.querySelector("[data-cms-page-content]");
  const list = container?.querySelector(":scope > [data-cms-blocks]");
  const blocks: Record<string, unknown>[] = [];
  if (!list) return { blocks };

  for (const block of Array.from(
    list.querySelectorAll(":scope > [data-cms-block]"),
  )) {
    if (block.hasAttribute("data-block-unavailable")) continue;
    const type = block.getAttribute("data-block-type");
    if (!type) continue;
    const fields = readFieldsIn(block, false);
    if (!Object.values(fields).some((value) => !isEmptyValue(value))) continue;
    blocks.push({ type, ...fields });
  }

  return { blocks };
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
  // The image picker is a convenience over the media-id input, which stays the
  // field's value: choosing an upload writes its id there, and a hand-typed id
  // works exactly the same. With JavaScript off the picker isn't read at all.
  form.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const picker = target.closest("[data-image-picker]");
    if (!(picker instanceof HTMLSelectElement)) return;
    const input = picker
      .closest("[data-field]")
      ?.querySelector<HTMLInputElement>("[data-image-id]");
    if (input) input.value = picker.value;
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

      const items = list.querySelector(":scope > [data-list-items]");
      const template = list.querySelector<HTMLTemplateElement>(
        ":scope > [data-list-template]",
      );
      if (!items || !template) return;

      const max = Number.parseInt(list.getAttribute("data-max") ?? "", 10);
      if (Number.isSafeInteger(max) && items.children.length >= max) return;
      items.append(template.content.cloneNode(true));
      return;
    }

    const addBlock = target.closest("[data-block-add]");
    if (addBlock) {
      event.preventDefault();
      const container = addBlock.closest("[data-cms-page-content]");
      const list = container?.querySelector(":scope > [data-cms-blocks]");
      const type = addBlock.getAttribute("data-block-add");
      if (!container || !list || !type) return;

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
      // `:scope >` so a nested control (a list row) is not what gets focused.
      firstControl(added)?.focus();
      return;
    }

    const removeBlock = target.closest("[data-block-remove]");
    if (removeBlock) {
      event.preventDefault();
      const block = removeBlock.closest("[data-cms-block]");
      if (!block) return;
      // A flagged block is uneditable, so its removal is recorded as a marker
      // rather than by serializing it; everything else is simply detached.
      if (block.hasAttribute("data-block-unavailable")) {
        markBlockRemoved(form, block);
      } else {
        block.remove();
      }
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

const wireForm = (form: HTMLFormElement): void => {
  wireControls(form);
  wireFocalPoint(form);

  form.addEventListener("submit", () => {
    const hidden = form.querySelector<HTMLInputElement>("[data-cms-content]");
    if (!hidden) return;
    // A page form's content is `{ blocks: [...] }`; a slot form's is its fields.
    hidden.value = JSON.stringify(
      form.querySelector("[data-cms-page-content]")
        ? buildPageContent(form)
        : buildContent(form),
    );
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
